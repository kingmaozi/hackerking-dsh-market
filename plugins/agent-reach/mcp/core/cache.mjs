/**
 * 缓存层：内存 TTL 缓存，按 provider / 账号非秘密标识 / 查询内容 / 时间窗分区。
 * 隐私与时效边界：live 请求禁缓存；不同账号不共享；错误与取消结果不入缓存。
 */

export const CACHE_TIERS = {
  news: 60_000,
  search: 600_000,
  static: 24 * 3600 * 1000,
};

/** 默认按查询特征推断缓存时长；live 由调用方显式禁用。 */
export function defaultTtl(query = "", freshness = "recent") {
  if (freshness === "live") return 0;
  if (freshness === "static") return CACHE_TIERS.static;
  if (/今天|今日|最新|刚刚|now|today|latest|breaking|实时/i.test(query)) return CACHE_TIERS.news;
  return CACHE_TIERS.search;
}

/** 账号分区键：只使用非秘密标识（例如 key 的哈希前缀或实例名），不保存原始凭据。 */
export function accountScope(providerId, credentialHint) {
  const raw = String(credentialHint ?? "");
  if (!raw) return `${providerId}:anon`;
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) h = Math.imul(h ^ raw.charCodeAt(i), 16777619) >>> 0;
  return `${providerId}:${h.toString(36)}`;
}

function normalizeKeyPart(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function cacheKey({ provider, scope, operation, query, urls, limit, freshness }) {
  const parts = [
    provider,
    scope,
    operation,
    normalizeKeyPart(query),
    Array.isArray(urls) ? [...urls].map(normalizeKeyPart).sort().join("|") : "",
    String(limit ?? ""),
    // live 与 static 的结果不可互相复用
    freshness ?? "",
  ];
  return parts.join("::");
}

/**
 * 创建缓存实例。默认仅内存；可选提供持久化钩子（本版本不使用，避免正文落盘）。
 */
export function createCache({ now = () => Date.now(), maxEntries = 500 } = {}) {
  const store = new Map();
  let hits = 0;
  let misses = 0;

  function pruneExpired() {
    const ts = now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= ts) store.delete(key);
    }
  }

  function evictIfNeeded() {
    if (store.size <= maxEntries) return;
    // 简单策略：先清过期，仍超限则删最旧的。
    pruneExpired();
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }

  return {
    /**
     * 读取缓存。live 或 ttl 为 0 时必定 miss。
     */
    get(key, { ttl } = {}) {
      if (!ttl || ttl <= 0) {
        misses += 1;
        return null;
      }
      const entry = store.get(key);
      if (!entry) {
        misses += 1;
        return null;
      }
      if (entry.expiresAt <= now()) {
        store.delete(key);
        misses += 1;
        return null;
      }
      hits += 1;
      return { value: entry.value, ageMs: now() - entry.storedAt, storedAt: entry.storedAt };
    },

    /** 只缓存成功结果；错误、空结果与取消由调用方决定是否传入。 */
    set(key, value, { ttl } = {}) {
      if (!ttl || ttl <= 0) return false;
      store.set(key, { value, storedAt: now(), expiresAt: now() + ttl });
      evictIfNeeded();
      return true;
    },

    delete(key) {
      return store.delete(key);
    },

    clear() {
      store.clear();
    },

    stats() {
      return { size: store.size, hits, misses, hitRate: hits + misses === 0 ? null : hits / (hits + misses) };
    },
  };
}

/**
 * 包一层带缓存的 provider 执行。
 * 仅缓存 status==="ok" 的结果；证据中的正文同时受 ttl 约束。
 */
export async function withCache(cache, provider, task, ctx, options = {}) {
  const freshness = task.input?.freshness ?? options.freshness ?? "recent";
  const ttl = options.ttl ?? defaultTtl(task.input?.query, freshness);
  const scope = options.scope ?? `${provider.id}:anon`;
  const key = cacheKey({
    provider: provider.id,
    scope,
    operation: task.operation,
    query: task.input?.query,
    urls: task.input?.urls,
    limit: task.input?.limit,
    freshness,
  });

  const cached = cache.get(key, { ttl });
  if (cached) {
    return {
      ...cached.value,
      warnings: [...(cached.value.warnings || []), `cache_hit:age_ms=${Math.round(cached.ageMs)}`],
      usage: { ...(cached.value.usage || {}), calls: 0, readUrls: 0, fromCache: true },
    };
  }

  const outcome = await provider.execute(task, ctx, options);
  // 只缓存成功结果；错误、空结果、取消都不缓存成"成功"。
  if (outcome?.status === "ok" && (outcome.evidence?.length ?? 0) > 0) {
    cache.set(key, outcome, { ttl });
  }
  return outcome;
}
