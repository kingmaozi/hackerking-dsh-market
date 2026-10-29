import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, parse, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveMemoryPaths } from './store.js';

const queues = new Map();
export async function serialized(key, operation) {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
// Reject symlinks at every existing component, including an absent leaf's parents.
export async function assertPlainPath(path) {
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('memory path contains symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export async function settingsPath(project, options = {}) {
  const paths = await resolveMemoryPaths(project, options);
  const file = join(paths.dir, `${paths.slug}.settings.json`);
  await assertPlainPath(file);
  return file;
}
export async function memoryEnabled(project, options = {}) {
  const file = await settingsPath(project, options);
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (typeof value.enabled !== 'boolean') throw new Error('invalid memory settings');
    return value.enabled;
  } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
export async function assertMemoryEnabled(project, options = {}) {
  if (!await memoryEnabled(project, options)) throw new Error('project-memory: 此项目记忆已停用；在设置 → 记忆中启用');
}
export async function setMemoryEnabled(project, enabled, options = {}) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
  const paths = await resolveMemoryPaths(project, options);
  return serialized(paths.file, async () => {
    const file = await settingsPath(project, options);
    await mkdir(dirname(file), { recursive: true });
    await assertPlainPath(file);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ enabled }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
    return { enabled };
  });
}
