/**
 * Tools for the project-scoped memory store.
 *
 * Three tools, no host imports: the definitions are plain objects registered
 * through the `tools` service, so the plugin mounts on any profile that
 * exposes it.
 *
 *   memory_write  append one entry to the current project's memory
 *   memory_read   read the current project's memory
 *   memory_status where the memory lives and how many entries exist
 *
 * 根一律用 `effectiveProjectRoot`：工具、技能与设置面板必须认同一个"记忆归属根"，
 * 否则从无 marker 的工作区（如 `~/Downloads/dsaf`）写入会跑到 `$HOME`，
 * 面板却按归属根列出该项目。
 */
import { readdir } from 'node:fs/promises';
import { assertMemoryEnabled } from './settings.js';
import {
  appendProjectMemory,
  effectiveProjectRoot,
  readProjectMemory,
  resolveMemoryPaths,
} from './store.js';

const ERROR_PREFIX = 'project-memory:';

const text = (description) => ({ type: 'string', description });

/**
 * `ctx.tools.register()` 原样接收 definition，**不做**作者方言编译：只有
 * `defineTool()` 会调 `parameterSchemaSpecToJsonSchema`。
 *
 * 所以直接 `register({ parameters: { text: { required: true } } })` 送出去的
 * 是 `{text:{...}}`，没有 `type: "object"`，OpenAI 兼容端点会整轮拒绝：
 *   Invalid schema for function 'memory_read': schema must be a JSON Schema of
 *   'type: "object"', got 'type: null'
 *
 * 这里自己把作者方言（字段级 `required: true`）编译成标准 JSON Schema，跟
 * dsh-tools 的 `parameterSchemaSpecToJsonSchema` 保持同一形状。
 */
function compileParameters(fields = {}) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(fields)) {
    const { required: isRequired, ...rest } = spec;
    properties[key] = rest;
    if (isRequired === true) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
}

const memoryOutputSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['project', 'slug', 'path', 'entries', 'content'],
  properties: {
    project: { type: 'string' },
    slug: { type: 'string' },
    path: { type: 'string' },
    entries: { type: 'number' },
    content: { type: 'string' },
  },
});

const statusOutputSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['project', 'slug', 'path', 'exists', 'entries', 'bytes', 'files'],
  properties: {
    project: { type: 'string' },
    slug: { type: 'string' },
    path: { type: 'string' },
    exists: { type: 'boolean' },
    entries: { type: 'number' },
    bytes: { type: 'number' },
    files: { type: 'array', items: { type: 'string' } },
  },
});

/** Resolve the session working directory without a hard dependency on the service. */
async function sessionCwd(ctx, exec) {
  const workingDirectory = ctx.get?.('workingDirectory') ?? ctx.workingDirectory;
  if (workingDirectory !== undefined && typeof workingDirectory.ensure === 'function' && exec?.agent !== undefined) {
    return workingDirectory.ensure(exec.agent, exec.signal);
  }
  return process.cwd();
}

function textPart(body) {
  return [{ type: 'text', text: body }];
}

/**
 * Build the tool definitions for one plugin instance.
 * @param {{ ctx: any, config: Record<string, unknown> }} options
 */
export function createMemoryTools({ ctx, config = {} }) {
  const memoryRoot = typeof config.memoryRoot === 'string' && config.memoryRoot.length > 0
    ? config.memoryRoot
    : undefined;
  const prefix = typeof config.toolPrefix === 'string' && config.toolPrefix.length > 0
    ? config.toolPrefix
    : 'memory';

  const writeTool = {
    name: `${prefix}_write`,
    description:
      'Append one durable memory entry to the CURRENT project\'s memory file '
      + '(`<project>/.dsh/memory/<slug>.md`, slug = project basename + hash of its absolute path). '
      + 'Use it for verified conclusions, project conventions, commands, offsets and pitfalls that must '
      + 'survive this session. Other projects cannot read what you write here.',
    parameters: compileParameters({
      text: { type: 'string', required: true, description: 'The memory body. Write: phenomenon -> conclusion -> evidence (command/path/output) -> scope.' },
      title: text('Optional short heading (defaults to the first line of `text`).'),
      source: text('Optional provenance tag, e.g. "session 2026-10-20" or an evidence id.'),
    }),
    output: {
      schema: memoryOutputSchema(),
      render(args, value) {
        return textPart(
          `已写入项目记忆 ${value.path}（共 ${value.entries} 条）\n\n`
          + `slug: ${value.slug}\n`
          + `项目: ${value.project}\n`
          + `标题: ${args?.title ?? '(auto)'}\n\n`
          + `提示：需要立刻在会话里复用时调用 memory_read；其他项目的会话看不到这条记忆。`,
        );
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.();
      const cwd = await sessionCwd(ctx, exec);
      const root = await effectiveProjectRoot(cwd);
      await assertMemoryEnabled(root, { memoryRoot });
      const body = typeof args?.text === 'string' ? args.text : String(args?.text ?? '');
      if (body.trim().length === 0) throw new Error(`${ERROR_PREFIX} text 不能为空`);
      const state = await appendProjectMemory(root, {
        text: body,
        title: typeof args?.title === 'string' ? args.title : undefined,
        source: typeof args?.source === 'string' ? args.source : undefined,
      }, { memoryRoot });
      return {
        project: state.project,
        slug: state.slug,
        path: state.file,
        entries: state.entries.length,
        content: state.content,
      };
    },
  };

  const readTool = {
    name: `${prefix}_read`,
    description:
      'Read the CURRENT project\'s durable memory (`<project>/.dsh/memory/<slug>.md`). '
      + 'Returns the whole file plus the parsed entry count. Memory from other projects is never returned.',
    parameters: compileParameters({
      section: text('Optional case-insensitive substring; only matching entries are returned.'),
    }),
    output: {
      schema: memoryOutputSchema(),
      render(_args, value) {
        const body = value.content.trim().length > 0
          ? value.content
          : '（本项目尚无记忆。用 memory_write 写入第一条。）';
        return textPart(`${body}\n\n— ${value.entries} 条 · ${value.path}`);
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.();
      const cwd = await sessionCwd(ctx, exec);
      const root = await effectiveProjectRoot(cwd);
      await assertMemoryEnabled(root, { memoryRoot });
      const state = await readProjectMemory(root, { memoryRoot });
      const filter = typeof args?.section === 'string' ? args.section.trim().toLowerCase() : '';
      if (filter.length === 0) {
        return {
          project: state.project,
          slug: state.slug,
          path: state.file,
          entries: state.entries.length,
          content: state.content,
        };
      }
      const matched = state.entries.filter((entry) =>
        `${entry.title}\n${entry.body}`.toLowerCase().includes(filter));
      const content = matched.length === 0
        ? ''
        : matched.map((entry) => `## ${entry.timestamp} — ${entry.title}\n\n${entry.body}`).join('\n\n');
      return {
        project: state.project,
        slug: state.slug,
        path: state.file,
        entries: matched.length,
        content,
      };
    },
  };

  const statusTool = {
    name: `${prefix}_status`,
    description:
      'Report where the current project\'s memory lives (project root, slug, file, entry count, bytes) '
      + 'and which memory files exist in that directory. Use it to prove project isolation.',
    parameters: compileParameters(),
    output: {
      schema: statusOutputSchema(),
      render(_args, value) {
        return textPart(
          [
            `project: ${value.project}`,
            `slug: ${value.slug}`,
            `file: ${value.path}`,
            `exists: ${value.exists} · entries: ${value.entries} · bytes: ${value.bytes}`,
            `files in memory dir: ${value.files.length === 0 ? '(none)' : value.files.join(', ')}`,
          ].join('\n'),
        );
      },
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      exec?.signal?.throwIfAborted?.();
      const cwd = await sessionCwd(ctx, exec);
      const root = await effectiveProjectRoot(cwd);
      await assertMemoryEnabled(root, { memoryRoot });
      const state = await readProjectMemory(root, { memoryRoot });
      const paths = await resolveMemoryPaths(root, { memoryRoot });
      let files = [];
      try {
        files = (await readdir(paths.dir)).filter((name) => name.endsWith('.md')).sort();
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      return {
        project: state.project,
        slug: state.slug,
        path: state.file,
        exists: state.exists,
        entries: state.entries.length,
        bytes: Buffer.byteLength(state.content, 'utf8'),
        files,
      };
    },
  };

  return [writeTool, readTool, statusTool];
}
