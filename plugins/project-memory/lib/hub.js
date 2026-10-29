/**
 * Cross-project memory hub.
 *
 * `store.js` owns one project's memory. This module answers the other
 * question the settings page asks: **which projects exist, and what does each
 * one remember?**
 *
 * Enumeration deliberately does not scan the filesystem. A project only shows
 * up when DSH itself knows about it, which keeps the panel honest about what
 * the GUI can reach:
 *
 *   1. `$DSH_HOME/storages/workspace.json` — the harness's own workspace
 *      registry (`tables.workspaces[uuid] = { path, title, sessionIds }`).
 *   2. the optional project-relative memory root on disk, which is what makes
 *      a workspace "have memory" in the first place.
 *
 * Storage stays where it has always been (`<project>/.dsh/memory/<slug>.md`)
 * so memory keeps travelling with the repository and staying diff-able. The
 * hub is a read-mostly projection over that layout, not a second store.
 *
 * No DSH imports here either, so plain Node scripts (the in-repo
 * `scripts/hub-regression.mjs`, plus ad-hoc read-only probes) can run the exact
 * same code outside the harness.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { assertPlainPath } from './settings.js';

/**
 * 注册校验：接受注册工作区**本身**，也接受它们的记忆归属根（折叠根）。
 *
 * 折叠根通常不是注册工作区（它是被折叠子工作区的解析根），但设置面板正是按
 * 归属根列行、按归属根读写；只认注册表原始 path 会让这些行一读就抛
 * `project not in the workspace registry`。
 */
async function assertRegistered(projectPath, allowedPaths) {
  const absolute = await realpath(resolve(projectPath));
  const registered = allowedPaths ?? (await listRegisteredWorkspaces()).map(row => row.path);
  const allowed = new Set();
  for (const path of registered) {
    const resolved = await realpath(resolve(path)).catch(() => null);
    if (resolved === null) continue;
    allowed.add(resolved);
    try {
      allowed.add(await effectiveProjectRoot(resolved));
    } catch { /* 读不动的注册路径不扩大权限 */ }
  }
  if (!allowed.has(absolute)) throw new Error('project not in the workspace registry');
  return absolute;
}

import {
  DEFAULT_MEMORY_ROOT,
  appendProjectMemory,
  effectiveProjectRoot,
  parseEntries,
  projectIdentity,
  readProjectMemory,
  resolveMemoryPaths,
} from './store.js';

/** Harness home: respects `DSH_HOME`, falls back to `~/.dsh`. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return resolve(fromEnv);
  return join(homedir(), '.dsh');
}

/** Absolute path of the harness workspace registry. */
export function workspaceRegistryPath() {
  return join(dshHome(), 'storages', 'workspace.json');
}

/**
 * Read every workspace DSH knows about.
 *
 * The registry is a versioned store (`{ unit, global, tables }`); a malformed
 * or missing file yields an empty list rather than throwing, because the panel
 * must still render for a first-run harness.
 * @returns {Promise<Array<{ id: string, path: string, title: string, sessions: number }>>}
 */
export async function listRegisteredWorkspaces() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(workspaceRegistryPath(), 'utf8'));
  } catch {
    return [];
  }
  const table = parsed?.tables?.workspaces;
  if (table === null || typeof table !== 'object') return [];
  const out = [];
  for (const [id, value] of Object.entries(table)) {
    if (value === null || typeof value !== 'object') continue;
    const path = value.path;
    if (typeof path !== 'string' || path.length === 0) continue;
    out.push({
      id,
      path,
      title: typeof value.title === 'string' && value.title.length > 0 ? value.title : basename(path),
      sessions: Array.isArray(value.sessionIds) ? value.sessionIds.length : 0,
    });
  }
  return out;
}

/**
 * Every memory file under one project's memory directory.
 *
 * A project normally owns exactly one file (`<slug>.md`), but a renamed
 * directory leaves the previous slug behind, so the panel lists them all
 * instead of pretending the canonical name is the only one.
 * @param {string} projectRoot
 * @param {{ memoryRoot?: string }} [options]
 */
export async function listMemoryFiles(projectRoot, options = {}) {
  const paths = await resolveMemoryPaths(projectRoot, options);
  await assertPlainPath(paths.dir);
  let names = [];
  try {
    names = await readdir(paths.dir);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }
  const files = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const file = join(paths.dir, name);
    await assertPlainPath(file);
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    files.push({
      name,
      file,
      bytes: info.size,
      updatedAt: info.mtime.toISOString(),
      canonical: name === `${paths.slug}.md`,
    });
  }
  files.sort((a, b) => (a.canonical === b.canonical ? a.name.localeCompare(b.name) : a.canonical ? -1 : 1));
  return files;
}

/**
 * 记忆工作区枚举：**一个记忆归属根一行**。
 *
 * `web.js` 的 `/workspaces` 与 `overview()` 都只走这里，两处口径不会再分叉
 * （修复前 API 用 `resolveProjectRoot(path) !== path` 直接丢弃子目录，`overview`
 * 不过滤，于是同一注册表一个 2 行、一个 16 行）。
 *
 * 契约：
 *   - `path` 是记忆归属根（`effectiveProjectRoot`），不是注册路径；
 *   - 去重键是 realpath 后的根，symlink 拼写不会产生重复行；
 *   - 多个工作区映射到同一根时只留一行；
 *   - 嵌套工作区仅在解析根是**另一个注册工作区**时折叠到那一行，否则保留自己的行；
 *   - `id` 优先取"根就是自己"的那个工作区，保证折叠后父级标题/ID 不被子目录顶掉。
 *
 * @param {{ workspaces?: Array<{ id?: string, workspaceId?: string, path: string, title?: string, sessions?: number }> | (() => Promise<Array<any>>) }} [options]
 *   `workspaces` 可以是数组，也可以是返回数组的函数（宿主 `workspaceRegistry.list()`）；
 *   省略时读 `$DSH_HOME/storages/workspace.json`。
 * @returns {Promise<Array<{ id: string, path: string, title: string, sessions: number, sourcePath: string }>>}
 */
export async function listManageableWorkspaces(options = {}) {
  const input = options.workspaces;
  const listed = typeof input === 'function'
    ? await input()
    : Array.isArray(input)
      ? input
      : await listRegisteredWorkspaces();
  const items = Array.isArray(listed) ? listed : [];

  const resolved = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    if (typeof item.path !== 'string' || item.path.length === 0) continue;
    let path;
    try {
      // realpath 先做：去重键必须是有效根，不然 symlink 拼写会重复成两行。
      path = await realpath(resolve(item.path));
    } catch { /* vanished workspaces are not filesystem authority */ continue; }
    // 归属根算不出来（权限、循环链接、祖先不可读）时退回"自己"这一行：
    // 单行错误丢掉整行会让父与子一起从面板里消失（review m7）。
    // `degraded` 只做排查标注，不出现在 API 行字段里。
    let root = path;
    let degraded = false;
    try {
      root = await effectiveProjectRoot(path);
    } catch {
      degraded = true;
    }
    resolved.push({
      id: item.id ?? item.workspaceId ?? path,
      path,
      root,
      degraded,
      title: item.title || basename(path),
      // 宿主 `workspaceRegistry` 实体只有 `sessionIds`（无 `sessions`）；
      // 磁盘注册表行自带 `sessions`。两种形态都算，live 路线才不会恒为 0。
      sessions: Array.isArray(item.sessionIds)
        ? item.sessionIds.length
        : (Number.isFinite(item.sessions) ? item.sessions : 0),
    });
  }

  const registered = new Set(resolved.map((item) => item.path));
  const groups = new Map();
  for (const item of resolved) {
    const group = groups.get(item.root) ?? { root: item.root, items: [], owner: undefined };
    if (item.path === item.root && group.owner === undefined) group.owner = item;
    group.items.push(item);
    groups.set(item.root, group);
  }

  const rows = [];
  for (const group of groups.values()) {
    // 根是另一个注册工作区：折叠到那一行，不额外开行也不额外开开关。
    if (group.owner === undefined && registered.has(group.root)) continue;
    const lead = group.owner ?? group.items[0];
    rows.push({
      id: lead.id,
      path: group.root,
      title: lead.title,
      sessions: group.items.reduce((sum, item) => sum + item.sessions, 0),
      sourcePath: lead.path,
      // 归属根降级（算不出来退回自己）时标出来，方便排查；不影响 API 行字段。
      degraded: group.items.some((item) => item.degraded),
    });
  }
  return rows;
}

/**
 * One summary row per workspace, ordered the way the panel wants to show it:
 * projects with memory first (most recently updated on top), then the rest
 * alphabetically.
 *
 * 行是按 `listManageableWorkspaces()` 的**记忆归属根**列的，与设置面板
 * `/workspaces` 返回同一批 `path`：记忆写到哪个根，行就指向哪个根。
 *
 * `workspacePaths` is supplied by the DSH half (the live registry service)
 * when it is available; otherwise the on-disk registry is used, so the same
 * function serves both the in-harness panel and the standalone script.
 * @param {{ workspacePaths?: Array<{ path: string, title?: string }>, memoryRoot?: string, extraPaths?: string[] }} [options]
 */
export async function overview(options = {}) {
  const memoryRoot = options.memoryRoot ?? DEFAULT_MEMORY_ROOT;
  const manageable = await listManageableWorkspaces({
    // 传了数组就是"这批注册表"，空数组就是空注册表；只有没传时才读磁盘注册表。
    workspaces: Array.isArray(options.workspacePaths) ? options.workspacePaths : undefined,
  });
  // Never enlarge filesystem authority using cwd or extraPaths.

  const rows = [];
  for (const candidate of manageable) {
    let identity;
    try {
      identity = await projectIdentity(candidate.path);
    } catch {
      continue;
    }
    // 单行不可读（项目目录 / `.dsh` 权限、循环链接）不能让 overview 抛异常，也不能
    // 把这一行丢掉：按"没有记忆文件"展示并标 degraded。这两个字段只在本模块内部
    // 使用，不会进 API 行（web.js 只映射 id/path/title）。
    let degraded = candidate.degraded === true;
    let paths;
    try {
      paths = await resolveMemoryPaths(candidate.path, { memoryRoot });
    } catch {
      degraded = true;
      paths = {
        dir: join(candidate.path, memoryRoot),
        file: join(candidate.path, memoryRoot, `${identity.slug}.md`),
      };
    }
    let files = [];
    try {
      files = await listMemoryFiles(candidate.path, { memoryRoot });
    } catch {
      degraded = true;
      files = [];
    }
    const canonical = files.find((file) => file.canonical);
    let entries = 0;
    let bytes = 0;
    let updatedAt = '';
    if (canonical !== undefined) {
      try {
        const state = await readProjectMemory(candidate.path, { memoryRoot });
        entries = state.entries.length;
      } catch {
        entries = 0;
      }
      bytes = canonical.bytes;
      updatedAt = canonical.updatedAt;
    }
    rows.push({
      path: candidate.path,
      title: candidate.title,
      // 记忆归属根对应的注册工作区路径：折叠行保留原始路径便于排查。
      workspacePath: candidate.sourcePath,
      slug: identity.slug,
      dir: paths.dir,
      file: canonical?.file ?? paths.file,
      files: files.map(({ name, bytes: size, updatedAt: at, canonical: isCanonical }) => ({
        name,
        bytes: size,
        updatedAt: at,
        canonical: isCanonical,
      })),
      // 只认本项目 canonical `<slug>.md`：shared 绝对 memoryRoot 下目录里还有
      // 别的项目的文件，`files.length > 0` 会把它算成本项目"有记忆"（review m11）。
      exists: canonical !== undefined,
      entries,
      bytes,
      updatedAt,
      // 归属根或记忆目录读不动时标出来（内部排查用；q.v. web.js 不暴露此字段）。
      degraded,
    });
  }

  rows.sort((a, b) => {
    if (a.exists !== b.exists) return a.exists ? -1 : 1;
    if (a.exists && b.exists) {
      const at = a.updatedAt || '';
      const bt = b.updatedAt || '';
      if (at !== bt) return bt.localeCompare(at);
    }
    return a.title.localeCompare(b.title);
  });

  return {
    dshHome: dshHome(),
    workspaceRegistry: workspaceRegistryPath(),
    memoryRoot,
    total: rows.length,
    withMemory: rows.filter((row) => row.exists).length,
    entries: rows.reduce((sum, row) => sum + row.entries, 0),
    projects: rows,
  };
}

/**
 * Full memory for one project: parsed entries plus raw Markdown.
 *
 * 只认本项目的 canonical `<slug>.md`。绝对 `memoryRoot` 下同一个目录里可能躺着
 * 别的项目的记忆文件，`files[0]` 之类的兜底会跨项目读到别人的内容，所以没有
 * canonical 文件时返回空态（文件列表仍如实给出）。
 * @param {string} projectPath
 * @param {{ memoryRoot?: string, allowedPaths?: string[] }} [options]
 */
export async function readProject(projectPath, options = {}) {
  const absolute = await assertRegistered(projectPath, options.allowedPaths);
  const paths = await resolveMemoryPaths(absolute, options);
  const files = await listMemoryFiles(absolute, options);
  const listing = files.map(({ name, bytes, updatedAt, canonical }) => ({ name, bytes, updatedAt, canonical }));
  const canonical = files.find((file) => file.canonical);
  if (canonical === undefined) {
    return {
      path: absolute,
      title: basename(absolute),
      slug: paths.slug,
      dir: paths.dir,
      file: paths.file,
      exists: false,
      content: '',
      entries: [],
      files: listing,
    };
  }
  let content = '';
  try {
    content = await readFile(canonical.file, 'utf8');
  } catch {
    content = '';
  }
  return {
    path: absolute,
    title: basename(absolute),
    slug: paths.slug,
    dir: paths.dir,
    file: canonical.file,
    exists: content.trim().length > 0,
    content,
    entries: parseEntries(content),
    files: listing,
  };
}

/**
 * Append one entry to a project's memory.
 *
 * The path is checked against the registry first: the panel may only write to
 * a project DSH already knows about, so a forged request cannot drop files
 * into an arbitrary directory.
 * @param {string} projectPath
 * @param {{ text: string, title?: string, source?: string }} entry
 * @param {{ memoryRoot?: string, allowedPaths?: string[] }} [options]
 */
export async function appendToProject(projectPath, entry, options = {}) {
  const absolute = await assertRegistered(projectPath, options.allowedPaths);
  const state = await appendProjectMemory(absolute, entry, { memoryRoot: options.memoryRoot });
  return {
    path: state.project,
    slug: state.slug,
    file: state.file,
    entries: state.entries.length,
  };
}
