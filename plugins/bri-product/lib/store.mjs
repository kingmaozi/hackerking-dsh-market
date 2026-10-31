import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';

export const INDEX_VERSION = 1;

export function getHome() {
  return process.env.BRI_PRODUCT_LIBRARY_HOME || join(homedir(), '.bri-product-library');
}

export function getPaths(home = getHome()) {
  return {
    home,
    index: join(home, 'index.json'),
    meta: join(home, 'meta.json'),
    cache: join(home, 'cache'),
    lock: join(home, 'sync.lock'),
  };
}

export async function ensureHome(home = getHome()) {
  const paths = getPaths(home);
  await mkdir(paths.cache, { recursive: true });
  return paths;
}

function emptyIndex() {
  return {
    version: INDEX_VERSION,
    updatedAt: null,
    source: null,
    products: [],
  };
}

export async function loadIndex(home = getHome()) {
  const paths = getPaths(home);
  try {
    const text = await readFile(paths.index, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.products)) return emptyIndex();
    return {
      version: parsed.version || INDEX_VERSION,
      updatedAt: parsed.updatedAt || null,
      source: parsed.source || null,
      products: parsed.products,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyIndex();
    if (error instanceof SyntaxError) return emptyIndex();
    throw error;
  }
}

async function atomicWrite(path, content) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, path);
}

export async function saveIndex(index, home = getHome()) {
  const paths = await ensureHome(home);
  const payload = {
    version: INDEX_VERSION,
    updatedAt: index.updatedAt || new Date().toISOString(),
    source: index.source || null,
    products: Array.isArray(index.products) ? index.products : [],
  };
  await atomicWrite(paths.index, `${JSON.stringify(payload)}\n`);
  return payload;
}

export async function loadMeta(home = getHome()) {
  const paths = getPaths(home);
  try {
    const text = await readFile(paths.meta, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

export async function saveMeta(meta, home = getHome()) {
  const paths = await ensureHome(home);
  await atomicWrite(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

/** 单进程级别的同步锁：避免 SessionStart 钩子和手动同步同时写库。 */
export async function withLock(fn, home = getHome(), staleMs = 10 * 60 * 1000) {
  const paths = await ensureHome(home);
  let handle;
  let acquired = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await writeFile(paths.lock, `${process.pid} ${new Date().toISOString()}\n`, {
        flag: 'wx',
      });
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let info;
      try {
        info = await stat(paths.lock);
      } catch {
        continue;
      }
      if (Date.now() - info.mtimeMs > staleMs) {
        await unlink(paths.lock).catch(() => {});
        continue;
      }
      throw new Error('另一个产品库同步正在进行，请稍后重试');
    }
  }

  if (!acquired) throw new Error('无法获取产品库同步锁');

  try {
    return await fn();
  } finally {
    await unlink(paths.lock).catch(() => {});
    if (handle) {
      // writeFile 已关闭句柄，这里仅保留变量以表达锁的生命周期。
    }
  }
}

export async function indexStats(home = getHome()) {
  const paths = getPaths(home);
  let indexBytes = 0;
  let metaBytes = 0;
  try {
    indexBytes = (await stat(paths.index)).size;
  } catch {}
  try {
    metaBytes = (await stat(paths.meta)).size;
  } catch {}
  return { indexBytes, metaBytes };
}
