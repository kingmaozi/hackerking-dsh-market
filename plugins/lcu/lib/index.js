import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from './provider.js';

export const name = 'lcu';
export const inject = ['skills'];

const PROVIDER_NAME = 'lcu';
const DEFAULT_RANK = 490;

/**
 * Skill provider for `lcu-computer-use`. The MCP side is the relay wired by
 * `cordis.patch.yml` (`serverName: lcu`), not this plugin.
 */
export function apply(ctx, config = {}) {
  if (config.providerName === 'runtime') throw new Error('[lcu] providerName "runtime" is reserved');
  const here = dirname(fileURLToPath(import.meta.url));
  const skillDir = typeof config.skillDir === 'string' && config.skillDir.length > 0
    ? resolve(config.skillDir)
    : resolve(here, '..', 'skills');
  const providerName = config.providerName ?? PROVIDER_NAME;
  ctx.logger.info(`[lcu] skill provider "${providerName}" -> ${skillDir}`);
  ctx.effect(() => ctx.skills.registerProvider(() => new DirectorySkillProvider({
    logger: ctx.logger,
    providerName,
    skillDir,
    rank: config.rank ?? DEFAULT_RANK,
  })));
}

export default { name, inject, apply };
