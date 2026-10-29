import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { listManageableWorkspaces } from './hub.js';
import { readProjectMemory, resolveMemoryPaths } from './store.js';
import { assertPlainPath, memoryEnabled, setMemoryEnabled } from './settings.js';

export const API = '/api/project-memory';

/**
 * "读不动"的文件系统错误：EACCES / EPERM（权限）、ELOOP（循环链接）、
 * ENOTDIR / EISDIR（类型不对）。只有这些才降级；symlink 拒绝（assertPlainPath
 * 抛的普通 Error）与坏 settings JSON 仍然照原样失败——容错不能吃掉安全校验。
 */
const FS_UNREADABLE = new Set(['EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'EISDIR']);

export function createMemoryRoute({ workspaces, origin, memoryRoot, invalidate = () => {} }) {
  const token = randomBytes(32).toString('hex');
  const options = { memoryRoot };
  // 与 overview() 共用同一份枚举（hub.listManageableWorkspaces）：
  // path 是记忆归属根，按根去重，嵌套工作区只在解析根是另一个注册工作区时折叠。
  // 这样面板行与 API 行永远是同一批 path，不会再出现 16 行 vs 2 行。
  async function registered() {
    const rows = await listManageableWorkspaces({ workspaces });
    return rows.map(({ id, path, title }) => ({ id, path, title }));
  }
  return { kind: 'prefix', path: API, async handler(req, res) {
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    try {
      const expected = new URL(origin());
      const peer = req.socket.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) || req.headers.host !== expected.host) return json(403, { error: 'origin denied' });
      if (req.headers.origin !== undefined && req.headers.origin !== expected.origin) return json(403, { error: 'origin denied' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'cross-site denied' });
      const url = new URL(req.url, expected);
      if (url.pathname === API + '/workspaces' && req.method === 'GET') {
        // 单行读失败（项目目录或 `.dsh` 权限、循环链接）绝不能放大成整批 400——
        // 那会让面板一行都不剩、连排查入口都没有。这里只报"开关状态"、不含记忆
        // 正文，所以任意单行失败都降级为"启用"；正文/路径的安全校验在 /memory 里
        // 仍然严格（symlink 依旧 400）。
        const projects = await Promise.all((await registered()).map(async (row) => ({
          ...row,
          enabled: await memoryEnabled(row.path, options).catch(() => true),
        })));
        return json(200, { projects, csrfToken: token });
      }
      if (!['GET', 'POST'].includes(req.method)) return json(405, { error: 'method denied' });
      let body = {};
      if (req.method === 'POST') {
        if (req.headers.origin !== expected.origin || req.headers['x-project-memory-csrf'] !== token || req.headers['content-type'] !== 'application/json') return json(403, { error: 'csrf denied' });
        let text = '';
        for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 4096) return json(413, { error: 'body too large' }); }
        body = JSON.parse(text);
      }
      const id = req.method === 'GET' ? url.searchParams.get('id') : body.id;
      const row = (await registered()).find(item => item.id === id);
      if (!row) return json(403, { error: 'workspace not registered' });
      await assertPlainPath(resolve(row.path));
      if (url.pathname === API + '/memory' && req.method === 'GET') {
        // 同一行两处读各自降级，但只降"读不动"：记忆读不到 → 空 entries；开关读不到
        // → 保守按启用。取舍：不可读是文件系统问题，不是"用户停用"的表达，宁可显示
        // "启用 + 空"，也不要把 EACCES 变成 400 或谎报停用；记忆文件路径照样给出，
        // 便于定位权限问题。symlink 拒绝 / 坏 settings 等仍按原样抛给外层 → 400。
        const enabled = await memoryEnabled(row.path, options).catch((error) => {
          if (!FS_UNREADABLE.has(error?.code)) throw error;
          return true;
        });
        const state = await readProjectMemory(row.path, options).catch((error) => {
          if (!FS_UNREADABLE.has(error?.code)) throw error;
          return null;
        });
        const file = state?.file
          ?? await resolveMemoryPaths(row.path, options).then((paths) => paths.file).catch(() => null);
        return json(200, { ...row, enabled, entries: state?.entries ?? [], file });
      }
      if (url.pathname === API + '/enabled' && req.method === 'POST') {
        const state = await setMemoryEnabled(row.path, body.enabled, options);
        invalidate();
        return json(200, state);
      }
      return json(404, { error: 'route not found' });
    } catch (error) { return json(400, { error: error.message }); }
  } };
}
