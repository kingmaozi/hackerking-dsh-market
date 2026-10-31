import {
  diffCatalog,
  normalizeProduct,
} from './catalog.mjs';
import {
  getHome,
  getPaths,
  loadIndex,
  loadMeta,
  saveIndex,
  saveMeta,
  withLock,
} from './store.mjs';
import { assertAllowedUrl } from './net.mjs';

export const DEFAULT_SERVER = (process.env.BRI_PRODUCT_LIBRARY_SERVER || 'https://ai.bri-king.com').replace(/\/+$/, '');
export const LOCAL_FALLBACK = (process.env.BRI_PRODUCT_LIBRARY_LOCAL_SERVER || 'http://127.0.0.1:8001').replace(/\/+$/, '');

const DEFAULT_TIMEOUT_MS = 20000;

async function requestPage(server, page, pageSize, timeoutMs, fetchImpl) {
  const url = `${server}/api/products?page=${page}&pageSize=${pageSize}&source=default`;
  assertAllowedUrl(url, '产品库同步地址');
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'bri-product/0.2.0',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}（${server}）`);
  const payload = await response.json();
  if (!payload?.success || !Array.isArray(payload.data)) {
    throw new Error(`接口返回格式不正确（${server}）`);
  }
  return { rows: payload.data, total: Number(payload.total ?? payload.data.length) };
}

export async function fetchCatalog(options = {}) {
  const {
    server = DEFAULT_SERVER,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = options;

  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 环境不支持 fetch');

  const first = await requestPage(server, 1, 9999, timeoutMs, fetchImpl);
  let rows = first.rows;
  const total = first.total;

  // 商品数超过单页上限时补充分页，按 id 去重。
  if (rows.length < total) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const pageSize = 1000;
    const maxPages = Math.ceil(total / pageSize) + 2;
    for (let page = 1; page <= maxPages && byId.size < total; page += 1) {
      const next = await requestPage(server, page, pageSize, timeoutMs, fetchImpl);
      if (next.rows.length === 0) break;
      for (const row of next.rows) byId.set(row.id, row);
    }
    rows = [...byId.values()];
  }

  return { rows, total: rows.length, server };
}

async function fetchWithFallback(options = {}) {
  const {
    server = DEFAULT_SERVER,
    allowedServers,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = options;

  const candidates = [];
  for (const candidate of allowedServers || [server, LOCAL_FALLBACK]) {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  }

  const errors = [];
  for (const candidate of candidates) {
    try {
      const result = await fetchCatalog({ server: candidate, timeoutMs, fetchImpl });
      return { ...result, attempted: candidate };
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }

  throw new Error(`无法从服务器拉取产品库（${errors.join('；')}）`);
}

export async function syncCatalog(options = {}) {
  const {
    force = false,
    maxAgeMs = 6 * 60 * 60 * 1000,
    server = DEFAULT_SERVER,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    home = getHome(),
    now = new Date(),
  } = options;

  const startedAt = Date.now();
  const meta = await loadMeta(home);
  const currentIndex = await loadIndex(home);
  const lastSync = meta.lastSyncAt ? Date.parse(meta.lastSyncAt) : 0;

  if (
    !force &&
    currentIndex.products.length > 0 &&
    lastSync > 0 &&
    now.getTime() - lastSync < maxAgeMs
  ) {
    return {
      ok: true,
      skipped: true,
      reason: 'fresh',
      lastSyncAt: meta.lastSyncAt,
      source: meta.server || currentIndex.source || server,
      total: currentIndex.products.length,
    };
  }

  const attemptAt = new Date().toISOString();
  let catalog;

  try {
    catalog = await fetchWithFallback({ server, timeoutMs, fetchImpl });
  } catch (error) {
    await saveMeta(
      {
        ...meta,
        lastAttemptAt: attemptAt,
        lastError: error.message,
      },
      home,
    );
    throw error;
  }

  const incoming = [];
  for (const row of catalog.rows) {
    const normalized = normalizeProduct(row);
    if (normalized) incoming.push(normalized);
  }

  if (incoming.length === 0) {
    const error = new Error('服务器返回了 0 个商品，已放弃本次同步');
    await saveMeta({ ...meta, lastAttemptAt: attemptAt, lastError: error.message }, home);
    throw error;
  }

  return withLock(
    async () => {
      const index = await loadIndex(home);
      const { products, changes } = diffCatalog(index.products, incoming, attemptAt);
      const syncedAt = new Date().toISOString();

      await saveIndex(
        {
          version: 1,
          updatedAt: syncedAt,
          source: catalog.server,
          products,
        },
        home,
      );

      const report = {
        ok: true,
        skipped: false,
        source: catalog.server,
        total: products.length,
        added: changes.added.length,
        updated: changes.updated.length,
        unchanged: changes.unchanged.length,
        localOnly: changes.localOnly.length,
        changes: {
          added: changes.added.slice(0, 20),
          updated: changes.updated.slice(0, 20),
          localOnly: changes.localOnly.slice(0, 20),
        },
        durationMs: Date.now() - startedAt,
        syncedAt,
      };

      await saveMeta(
        {
          ...meta,
          lastAttemptAt: attemptAt,
          lastSyncAt: syncedAt,
          lastError: null,
          server: catalog.server,
          counts: {
            total: report.total,
            added: report.added,
            updated: report.updated,
            unchanged: report.unchanged,
            localOnly: report.localOnly,
          },
          durationMs: report.durationMs,
          paths: getPaths(home),
        },
        home,
      );

      return report;
    },
    home,
  );
}

/**
 * 读取本地索引；索引为空时强制同步一次。
 * 过期时尝试后台式同步，失败则继续使用旧数据（离线可用）。
 */
export async function ensureIndex(options = {}) {
  const {
    home = getHome(),
    maxAgeMs = 24 * 60 * 60 * 1000,
    allowSync = true,
    timeoutMs = 25000,
    fetchImpl = globalThis.fetch,
  } = options;

  let index = await loadIndex(home);
  let meta = await loadMeta(home);

  if (index.products.length === 0) {
    if (!allowSync) {
      return { index, meta, sync: null };
    }
    const sync = await syncCatalog({ force: true, home, timeoutMs, fetchImpl });
    const report = { ...sync, attempted: true };
    index = await loadIndex(home);
    meta = await loadMeta(home);
    return { index, meta, sync: report };
  }

  const lastSync = meta.lastSyncAt ? Date.parse(meta.lastSyncAt) : 0;
  if (allowSync && Date.now() - lastSync > maxAgeMs) {
    try {
      const sync = await syncCatalog({
        force: true,
        home,
        timeoutMs,
        fetchImpl,
        maxAgeMs,
      });
      index = await loadIndex(home);
      meta = await loadMeta(home);
      return { index, meta, sync };
    } catch (error) {
      return { index, meta, sync: { ok: false, error: error.message } };
    }
  }

  return { index, meta, sync: null };
}
