import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from './provider.js';
import { buildRoles } from './roles.js';
import { createRoleTool } from './delegate.js';

export const name = 'feature-dev';
export const inject = ['skills'];

const PROVIDER_NAME = 'feature-dev';
const DEFAULT_RANK = 430;
const DEFAULT_TOOL_NAME = 'feature_dev_role';

export function apply(ctx, config = {}) {
  if (config.providerName === 'runtime') throw new Error('[feature-dev] providerName "runtime" is reserved');
  const here = dirname(fileURLToPath(import.meta.url));
  const skillDir = typeof config.skillDir === 'string' && config.skillDir.length > 0
    ? resolve(config.skillDir)
    : resolve(here, '..', 'skills');
  const providerName = config.providerName ?? PROVIDER_NAME;
  ctx.logger.info(`[feature-dev] skill provider "${providerName}" -> ${skillDir}`);
  ctx.effect(() => ctx.skills.registerProvider(() => new DirectorySkillProvider({
    logger: ctx.logger,
    providerName,
    skillDir,
    rank: config.rank ?? DEFAULT_RANK,
  })));

  // ---- role-bound delegation tool -------------------------------------------
  // The ZCode original pinned provider/model/thoughtLevel per agents/*.md file.
  // DSH has no per-file route, so the same binding is exposed as a tool whose
  // role table carries the route; see lib/roles.js for the resolution order.
  if (config.enableRoleTool === false) return;

  const roles = buildRoles(config);
  const tools = ctx.get?.('tools') ?? ctx.tools;
  if (tools === undefined || typeof tools.register !== 'function') {
    ctx.logger.warn('[feature-dev] tools 服务不可用，跳过角色派单工具（技能仍然可用）');
    return;
  }
  const subagents = ctx.get?.('subagents') ?? ctx.subagents;
  if (subagents === undefined || typeof subagents.startActivation !== 'function') {
    ctx.logger.warn('[feature-dev] subagents 服务不可用，跳过角色派单工具（技能仍然可用）');
    return;
  }

  const toolName = config.toolName ?? DEFAULT_TOOL_NAME;
  const transport = config.subagentProvider ?? 'spawn';
  const tool = createRoleTool({ ctx, config, roles, toolName, providerName: transport });
  ctx.logger.info(
    `[feature-dev] role tool "${toolName}" on subagent provider "${transport}" `
    + `roles=${Object.keys(roles).join(', ')}`,
  );
  ctx.effect(() => tools.register(tool));
}

export default { name, inject, apply };
