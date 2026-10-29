/**
 * Project-scoped memory store.
 *
 * ZCode keeps one memory directory per project under
 * `~/.zcode/cli/memories/projects/<name>-<hash>/memory/`. DSH has no such
 * store, so this module reproduces the two properties that matter:
 *
 *   1. the memory file lives under the project itself (`.dsh/memory/`), and
 *   2. the file name carries a slug derived from the **absolute project
 *      path**, so two projects never read each other's memory even when a
 *      memory root is shared (e.g. an absolute `memoryRoot`).
 *
 * All functions are pure filesystem operations with no DSH imports, which
 * lets `scripts/project-memory.mjs` reuse the exact same storage rules —
 * root resolution included: it calls `effectiveProjectRoot`, the same memory
 * attribution root the tools, the skill provider and the settings panel use.
 */
import { createHash } from 'node:crypto';
import { assertMemoryEnabled, assertPlainPath, serialized } from './settings.js';
import { appendFile, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Marker written into every generated memory file. */
export const MEMORY_FORMAT = 'project-memory/v1';

/** Default project-relative memory directory. */
export const DEFAULT_MEMORY_ROOT = '.dsh/memory';

/**
 * Project-root markers, most specific first: the first ancestor containing
 * `.git` wins; a project without git falls back to `.dsh`, then `package.json`.
 */
export const DEFAULT_ROOT_MARKERS = ['.git', '.dsh', 'package.json'];

const SLUG_BASENAME = /[^a-z0-9]+/g;

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function realpathSafe(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return resolve(path);
    throw error;
  }
}

/** 空的"跳过集合"：`resolveProjectRoot` 保留原有的全量向上查找语义。 */
const NO_SKIP = new Set();

/**
 * `.dsh` 里这些条目不算"项目声明"：`memory` 是 project-memory 自己的产物，
 * `.DS_Store` 是 Finder 噪声。只剩它们的 `.dsh`（例如 `<项目>/.dsh/memory/`）
 * 不说明这里声明过项目，因此不能当 marker —— 否则给父目录切一次开关或写一条
 * 记忆，父目录就变成 marker，已经注册的子工作区被折叠、整行消失（review B1）。
 */
const DSH_NON_DECLARATION = new Set(['memory', '.DS_Store']);

/**
 * `.dsh` 是否在声明一个 DSH 项目（`profile.yml` / `profile.patch.yml` /
 * `skills` / `plugins.yml` …），而不只是本插件留下的 `memory` 目录。
 * @param {string} dshDir `.dsh` 的绝对路径。
 * @returns {Promise<boolean>}
 */
async function declaresProject(dshDir) {
  let names;
  try {
    names = await readdir(dshDir);
  } catch (error) {
    // 不存在、或 `.dsh` 其实是普通文件：都不构成项目声明。
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    // 读不到（权限 / 循环链接）时保守按"有声明"处理：宁可把它当 marker，
    // 也不要把异常抛给上层——上层一旦失败，整行就会从面板里消失（review m7）。
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'ELOOP') return true;
    throw error;
  }
  return names.some((name) => !DSH_NON_DECLARATION.has(name));
}

/**
 * per-marker 判定：默认"存在即标记"，`.dsh` 额外要求包含项目声明。
 * 只有 `effectiveProjectRoot` 用这份判定；`resolveProjectRoot` 保持 legacy。
 */
const EFFECTIVE_MARKER_TESTS = { '.dsh': declaresProject };

/**
 * 按 marker 顺序向上查找项目根；`skip` 里的目录自身不参与匹配，但查找继续
 * 向上（它们只是容器，不是项目）。
 * @param {string} start 已 realpath 的起点。
 * @param {string[]} markers
 * @param {Set<string>} skip
 * @param {Record<string, (path: string) => Promise<boolean>>} [tests] 可选的 per-marker 判定。
 */
async function findMarkerRoot(start, markers, skip, tests = {}) {
  for (const marker of markers) {
    const test = tests[marker];
    let cursor = start;
    for (;;) {
      if (!skip.has(cursor)) {
        const candidate = join(cursor, marker);
        const present = typeof test === 'function' ? await test(candidate) : await pathExists(candidate);
        if (present) return cursor;
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return start;
}

/**
 * "容器"目录：用户家目录与 DSH 家目录（`$DSH_HOME`，默认 `$HOME/.dsh`）。
 *
 * 这两层里的 `.dsh` / `package.json` 是宿主安装产物，不是项目标记。家目录一旦
 * 被当成项目，所有自身没有 marker 的工作区都会被算成同一个项目——正是
 * `~/Documents/zuli` 明明有 `package.json` 却解析到 `$HOME` 的原因。
 *
 * 每次调用都重新求值、不缓存：`HOME` / `DSH_HOME` 会随 profile、测试夹具变化。
 * @returns {Promise<Set<string>>} 已 realpath 的容器目录集合。
 */
async function containerDirs() {
  const home = await realpathSafe(resolve(homedir()));
  const configured = process.env.DSH_HOME;
  // 默认分支也要 realpath：`~/.dsh` 可能是指向别处的 symlink，容器集合必须用
  // 解析后的真实路径，才能和遍历到的 `cursor` 对上（review m8）。
  const dsh = typeof configured === 'string' && configured.length > 0
    ? await realpathSafe(resolve(configured))
    : await realpathSafe(join(home, '.dsh'));
  return new Set([home, dsh]);
}

/**
 * Resolve the project root for a working directory by walking ancestors.
 *
 * 语义保持不变（marker 顺序、起点无 marker 时返回起点），并继续导出：它是
 * "纯 marker"参照，`scripts/hub-regression.mjs` 用它证明家目录抢占的旧行为。
 * 写入 / 读取 / 技能 / 面板已全部改走 `effectiveProjectRoot`——记忆归属根。
 * @param {string} [startDir] absolute or relative starting directory.
 * @param {{ markers?: string[] }} [options]
 * @returns {Promise<string>} absolute, symlink-resolved project root.
 */
export async function resolveProjectRoot(startDir = process.cwd(), options = {}) {
  const start = await realpathSafe(resolve(startDir));
  const markers = options.markers ?? DEFAULT_ROOT_MARKERS;
  return findMarkerRoot(start, markers, NO_SKIP);
}

/**
 * 记忆归属根：marker 逻辑与 `resolveProjectRoot` 相同，但有两处收紧——它们是
 * "面板里看得见的行"和"记忆实际写到哪"必须永远一致的前提：
 *
 * - `$HOME` 与 `$DSH_HOME` 只当容器：它们自己的 `.dsh` / `package.json` / `.git`
 *   不算项目标记，家目录因此不会抢占没有 marker 的子目录；
 * - `.dsh` 只有包含项目声明才算标记（`memory` / `.DS_Store` 除外），所以父目录
 *   切开关或写记忆自造的 `<父>/.dsh/memory` 不会把已注册的子工作区折叠掉。
 *
 * 起点自身就是 `$HOME` 或 `$DSH_HOME` 时仍返回自身（在家目录开会话依旧是一个项目）。
 * 与 `resolveProjectRoot` 的差异只来自容器目录和被忽略的 `memory` 目录：
 * `~/Documents/zuli` 是反例——legacy 按 marker 优先序先撞上家目录的 `.dsh` 返回
 * `$HOME`，这里返回 zuli 自己；带 `.git`、带声明式 `.dsh` 或只有 `package.json`
 * 且祖先没有上述两种 marker 时，两者结果一致。
 * @param {string} [startDir] absolute or relative starting directory.
 * @param {{ markers?: string[] }} [options]
 * @returns {Promise<string>} absolute, symlink-resolved memory attribution root.
 */
export async function effectiveProjectRoot(startDir = process.cwd(), options = {}) {
  const start = await realpathSafe(resolve(startDir));
  const skip = await containerDirs();
  if (skip.has(start)) return start;
  const markers = options.markers ?? DEFAULT_ROOT_MARKERS;
  return findMarkerRoot(start, markers, skip, EFFECTIVE_MARKER_TESTS);
}

/**
 * Derive the `<basename>-<hash16>` slug ZCode uses for a project directory.
 * The hash is the first 16 hex characters of SHA-256 over the resolved
 * absolute path, so renaming a directory changes the slug while symlinked
 * spellings of the same project do not.
 * @param {string} projectRoot absolute project root.
 * @returns {Promise<{ slug: string, hash: string, project: string }>}
 */
export async function projectIdentity(projectRoot) {
  const project = await realpathSafe(resolve(projectRoot));
  const hash = createHash('sha256').update(project).digest('hex').slice(0, 16);
  const base =
    basename(project)
      .toLowerCase()
      .replace(SLUG_BASENAME, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project';
  return { slug: `${base}-${hash}`, hash, project };
}

/**
 * Resolve the memory file for one project.
 * @param {string} projectRoot
 * @param {{ memoryRoot?: string }} [options] absolute path or project-relative directory.
 * @returns {Promise<{ project: string, slug: string, dir: string, file: string, memoryRoot: string }>}
 */
export async function resolveMemoryPaths(projectRoot, options = {}) {
  const memoryRoot = options.memoryRoot ?? DEFAULT_MEMORY_ROOT;
  const { slug, project } = await projectIdentity(projectRoot);
  const dir = isAbsolute(memoryRoot) ? resolve(memoryRoot) : join(project, memoryRoot);
  return { project, slug, dir, file: join(dir, `${slug}.md`), memoryRoot };
}

/** Parse `## ` sections out of a memory file. */
export function parseEntries(content) {
  const entries = [];
  const pattern = /^## (.+)$/gm;
  const matches = [...content.matchAll(pattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const bodyStart = match.index + match[0].length;
    const bodyEnd = index + 1 < matches.length ? matches[index + 1].index : content.length;
    const body = content.slice(bodyStart, bodyEnd).trim();
    const heading = match[1].trim();
    const separator = heading.indexOf(' — ');
    entries.push({
      title: separator === -1 ? heading : heading.slice(separator + 3).trim(),
      timestamp: separator === -1 ? '' : heading.slice(0, separator).trim(),
      body,
    });
  }
  return entries;
}

function headerFor({ slug, project }) {
  return [
    `<!-- ${MEMORY_FORMAT}`,
    `slug: ${slug}`,
    `project: ${project}`,
    `created: ${new Date().toISOString()}`,
    '-->',
    '',
    `# 项目记忆 · ${basename(project)} (${slug})`,
    '',
    '> 由 project-memory 维护：本文件只属于该项目，其他项目的会话读不到。',
    '> 每条记忆一个 `##` 小节；`memory_write` 追加，`memory_read` 读取。',
    '',
  ].join('\n');
}

function normalizeTitle(text, title) {
  if (typeof title === 'string' && title.trim().length > 0) return title.trim().slice(0, 120);
  const firstLine = text
    .trim()
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line.length > 0);
  return (firstLine ?? 'untitled').slice(0, 80);
}

/**
 * Read one project's memory.
 * @param {string} projectRoot
 * @param {{ memoryRoot?: string }} [options]
 * @returns {Promise<{ project: string, slug: string, dir: string, file: string, memoryRoot: string, exists: boolean, content: string, entries: Array<{ title: string, timestamp: string, body: string }> }>}
 */
export async function readProjectMemory(projectRoot, options = {}) {
  const paths = await resolveMemoryPaths(projectRoot, options);
  await assertPlainPath(paths.file);
  let content = '';
  try {
    content = await readFile(paths.file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { ...paths, exists: content.trim().length > 0, content, entries: parseEntries(content) };
}

/**
 * Append one entry to a project's memory file, creating file and directory on
 * first write. The write is append-only so concurrent readers never see a
 * truncated file.
 * @param {string} projectRoot
 * @param {{ text: string, title?: string, source?: string }} entry
 * @param {{ memoryRoot?: string }} [options]
 * @returns {Promise<Awaited<ReturnType<typeof readProjectMemory>>>}
 */
export async function appendProjectMemory(projectRoot, entry, options = {}) {
  const text = typeof entry.text === 'string' ? entry.text.trim() : '';
  if (text.length === 0) throw new Error('memory text is empty');
  if (text.length > 200_000) throw new Error('memory text is larger than 200000 characters');
  const paths = await resolveMemoryPaths(projectRoot, options);
  return serialized(paths.file, async () => {
  await assertMemoryEnabled(projectRoot, options);
  const existing = await readProjectMemory(projectRoot, options);
  const section = [
    `## ${new Date().toISOString()} — ${normalizeTitle(text, entry.title)}`,
    '',
    text,
  ];
  if (typeof entry.source === 'string' && entry.source.length > 0) {
    section.push('', `<!-- source: ${entry.source.replace(/-->/g, '--')} -->`);
  }
  section.push('');
  if (!existing.exists) {
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.file, `${headerFor(paths)}\n${section.join('\n')}`, 'utf8');
  } else {
    await mkdir(paths.dir, { recursive: true });
    await appendFile(paths.file, `\n${section.join('\n')}`, 'utf8');
  }
  return readProjectMemory(projectRoot, options);
  });
}

/** Overwrite a project's memory with explicit content (used by import/migration). */
export async function writeProjectMemory(projectRoot, content, options = {}) {
  const paths = await resolveMemoryPaths(projectRoot, options);
  return serialized(paths.file, async () => {
  await assertMemoryEnabled(projectRoot, options);
  await assertPlainPath(paths.file);
  await mkdir(paths.dir, { recursive: true });
  const body = typeof content === 'string' ? content : '';
  const text = body.startsWith('<!-- project-memory')
    ? body
    : `${headerFor(paths)}\n${body}`;
  await writeFile(paths.file, text, 'utf8');
  return readProjectMemory(projectRoot, options);
  });
}

/**
 * Render the memory for the `project-memory` skill body. The body is rebuilt on
 * every `get()`, so a skill load always sees the latest entries.
 * @param {Awaited<ReturnType<typeof readProjectMemory>>} state
 * @param {{ maxInjectBytes?: number }} [options]
 */
export function renderMemoryForSkill(state, options = {}) {
  const maxInjectBytes = Number.isFinite(options.maxInjectBytes) ? options.maxInjectBytes : 32768;
  const lines = [
    '# 项目记忆（project memory）',
    '',
    '这是**当前项目**的持久记忆，由 `project-memory` 插件按项目绝对路径哈希隔离。',
    '其他项目的记忆不会出现在这里；写入请用 `memory_write`，读取请用 `memory_read`。',
    '',
    `- 项目根：\`${state.project}\``,
    `- slug：\`${state.slug}\``,
    `- 记忆文件：\`${state.file}\``,
    `- 条目数：${state.entries.length}${state.exists ? '' : '（文件尚未创建）'}`,
    '',
    '## 使用规则',
    '',
    '- 会话开始时先读完本记忆，把「已验证结论 / 约定 / 踩坑 / 命令」当作项目事实，不要重复试错。',
    '- 得到可复用结论时调用 `memory_write`，写清楚：现象 → 结论 → 证据（命令/路径/偏移）→ 影响范围。',
    '- 记忆与当前代码/输出冲突时以现场证据为准，并写一条新记忆纠正旧条目。',
    '',
    '---',
    '',
  ];
  if (!state.exists) {
    lines.push('（本项目尚无记忆。用 `memory_write` 写入第一条。）');
  } else {
    let content = state.content;
    if (Buffer.byteLength(content, 'utf8') > maxInjectBytes) {
      content = `${Buffer.from(content, 'utf8').subarray(0, maxInjectBytes).toString('utf8')}\n\n…（已截断，完整内容见记忆文件）`;
    }
    lines.push(content.trimEnd());
  }
  return lines.join('\n');
}
