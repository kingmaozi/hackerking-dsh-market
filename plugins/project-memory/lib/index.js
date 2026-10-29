/**
 * project-memory — per-project durable memory for DeepSeek Harness.
 *
 * Two surfaces, both scoped by the session working directory:
 *
 *   - a skill provider publishing `project-memory`, whose body is rebuilt from
 *     `<project>/.dsh/memory/<slug>.md` on every load;
 *   - the `memory_write` / `memory_read` / `memory_status` tools backed by the
 *     same store.
 *
 * Nothing here touches the host prompt: memory enters the session through the
 * skill catalog entry (a project-scoped artifact), not through a global
 * instructions patch.
 */
import { ProjectMemoryProvider } from './provider.js';
import { createMemoryTools } from './tools.js';
import { createMemoryRoute } from './web.js';

export const name = 'project-memory';
export const inject = ['skills', 'tools'];

const PROVIDER_NAME = 'project-memory';
const SKILL_NAME = 'project-memory';

export function apply(ctx, config = {}) {
  if (config.providerName === 'runtime') throw new Error('[project-memory] providerName "runtime" is reserved');
  const providerName = config.providerName ?? PROVIDER_NAME;
  const skillName = config.skillName ?? SKILL_NAME;
  const memoryRoot = typeof config.memoryRoot === 'string' && config.memoryRoot.length > 0
    ? config.memoryRoot
    : undefined;

  ctx.logger.info(
    `[project-memory] skill "${skillName}" on provider "${providerName}" `
    + `memoryRoot=${memoryRoot ?? '.dsh/memory (per project)'}`,
  );
  let invalidateSkills = () => {};
  ctx.effect(() => ctx.skills.registerProvider((runtime) => {
    invalidateSkills = () => runtime?.invalidate?.();
    return new ProjectMemoryProvider({
    logger: ctx.logger,
    providerName,
    skillName,
    memoryRoot,
    maxInjectBytes: config.maxInjectBytes,
    rank: config.rank,
    });
  }));

  // Optional host services: command-line profiles retain skill/tool compatibility.
  if (typeof ctx.inject === 'function') ctx.inject(['webServer', 'workspaceRegistry'], inner => {
    const route = createMemoryRoute({
      workspaces: () => inner.workspaceRegistry.list(),
      origin: () => inner.webServer.getOrigin(),
      memoryRoot,
      invalidate: () => invalidateSkills(),
    });
    inner.effect(() => inner.webServer.register(route));
  });

  if (config.enableTools === false) return;

  // `tools` is injected, so it is ready by the time apply() runs; the get() form
  // keeps a diagnostic if the host ever mounts the plugin without the service.
  const tools = ctx.get?.('tools');
  if (tools === undefined || typeof tools.register !== 'function') {
    ctx.logger.warn('[project-memory] tools 服务不可用，跳过 memory_write/memory_read/memory_status（技能仍然可用）');
    return;
  }
  for (const definition of createMemoryTools({ ctx, config })) {
    ctx.effect(() => tools.register(definition));
  }
}

export default { name, inject, apply };
