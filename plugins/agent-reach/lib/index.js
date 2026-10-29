import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from './provider.js';

export const name = 'agent-reach';
export const inject = ['skills'];

const PROVIDER_NAME = 'agent-reach-mcp';
const DEFAULT_RANK = 480;

/**
 * Skill provider for the ported `agent-reach-mcp` skill (the `reach_*` MCP
 * workflow). The MCP server itself is wired by `cordis.patch.yml`.
 *
 * The skill is deliberately NOT named `agent-reach`: a CLI-based skill with
 * that name already lives in `~/.agents/skills/agent-reach`, and the registry
 * keeps one provider per skill name.
 */
export function apply(ctx, config = {}) {
  if (config.providerName === 'runtime') throw new Error('[agent-reach] providerName "runtime" is reserved');
  const here = dirname(fileURLToPath(import.meta.url));
  const skillDir = typeof config.skillDir === 'string' && config.skillDir.length > 0
    ? resolve(config.skillDir)
    : resolve(here, '..', 'skills');
  const providerName = config.providerName ?? PROVIDER_NAME;
  ctx.logger.info(`[agent-reach] skill provider "${providerName}" -> ${skillDir}`);
  ctx.effect(() => ctx.skills.registerProvider(() => new DirectorySkillProvider({
    logger: ctx.logger,
    providerName,
    skillDir,
    rank: config.rank ?? DEFAULT_RANK,
  })));
}

export default { name, inject, apply };
