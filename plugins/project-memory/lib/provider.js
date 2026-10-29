/**
 * `project-memory` skill provider.
 *
 * The catalog entry is stable (one skill, always listed while the plugin is
 * mounted) and the body is rebuilt on every `get()` from the current project's
 * `.dsh/memory/<slug>.md`. That keeps the skill catalog cacheable — DSH caches
 * provider `list()` results per cwd until a provider registers — while still
 * showing memory written earlier in the same session.
 *
 * The catalog is scoped by `lookup.cwd`, so session A (project A) and session B
 * (project B) receive different bodies even though both resolve this plugin.
 *
 * 根用 `effectiveProjectRoot`：与设置面板/`hub.overview()` 同一个"记忆归属根"，
 * 否则从无 marker 的工作区（如 `~/Downloads/dsaf`）看到的技能正文和写入位置
 * 会一起落到 `$HOME`。
 */
import { effectiveProjectRoot, readProjectMemory, renderMemoryForSkill } from './store.js';

import { memoryEnabled } from './settings.js';

const SKILL_NAME = 'project-memory';
const DEFAULT_RANK = 480;

export class ProjectMemoryProvider {
  /**
   * @param {{ logger: { warn: Function, info?: Function }, providerName: string,
   *   skillName?: string, memoryRoot?: string, maxInjectBytes?: number, rank?: number }} options
   */
  constructor(options) {
    this.name = options.providerName;
    this.skillName = options.skillName ?? SKILL_NAME;
    this.memoryRoot = options.memoryRoot;
    this.maxInjectBytes = options.maxInjectBytes;
    this.rank = options.rank ?? DEFAULT_RANK;
    this.logger = options.logger;
  }

  async #state(cwd) {
    const root = await effectiveProjectRoot(cwd ?? process.cwd());
    return readProjectMemory(root, { memoryRoot: this.memoryRoot });
  }

  /**
   * List the single `project-memory` skill for the viewing session's cwd.
   * @param {{ cwd?: string, signal?: AbortSignal }} [lookup]
   */
  async list(lookup = {}) {
    lookup.signal?.throwIfAborted?.();
    let state;
    try {
      state = await this.#state(lookup.cwd);
    } catch (error) {
      this.logger?.warn?.(`[${this.name}] cannot resolve project memory: ${String(error)}`);
      return [];
    }
    lookup.signal?.throwIfAborted?.();
    if (!await memoryEnabled(state.project, { memoryRoot: this.memoryRoot })) return [];
    const count = state.entries.length;
    return [
      {
        name: this.skillName,
        description:
          `项目级持久记忆：读取当前项目（${state.slug}）已验证的结论、约定、踩坑与命令；`
          + `本项目现有 ${count} 条。需要回忆/复用本项目历史结论时先加载。`,
        whenToUse:
          '会话开始、接手本项目、或要复用一个此前验证过的结论/命令/偏移时；'
          + '不要把其他项目的记忆当成本项目事实。',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'bundled',
        provider: this.name,
        rank: this.rank,
        locator: { root: state.project, slug: state.slug, file: state.file },
        path: state.file,
      },
    ];
  }

  /**
   * Load the memory skill body for the candidate's project (or the caller's cwd).
   * @param {{ locator?: { root?: string, slug?: string, file?: string }, name?: string }} candidate
   * @param {{ cwd?: string, signal?: AbortSignal }} [lookup]
   */
  async get(candidate, lookup = {}) {
    lookup.signal?.throwIfAborted?.();
    // The requesting session wins over a cached candidate from another cwd.
    const root = lookup.cwd ?? candidate?.locator?.root;
    const state = await this.#state(root);
    if (!await memoryEnabled(state.project, { memoryRoot: this.memoryRoot })) throw new Error('project-memory: 此项目记忆已停用');
    lookup.signal?.throwIfAborted?.();
    return {
      name: this.skillName,
      description:
        `项目级持久记忆（${state.slug}，${state.entries.length} 条）：本项目已验证的结论、约定与命令。`,
      whenToUse: '需要复用本项目历史结论、约定或命令时；写入用 memory_write。',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled',
      provider: this.name,
      path: state.file,
      content: renderMemoryForSkill(state, { maxInjectBytes: this.maxInjectBytes }),
    };
  }
}
