import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from './lib/provider.js';

export const name = 'bri-product';
export const inject = ['skills'];

const PROVIDER_NAME = 'bri-product';
/** Bundled plugin skills rank below user/project roots but above the shipped bundled dir (600). */
const DEFAULT_RANK = 490;

/**
 * Skill provider for `bri-product`. The MCP side is wired by
 * `cordis.patch.yml` (`serverName: bri_product`), not this plugin.
 */
export function apply(ctx, config = {}) {
  if (config.providerName === 'runtime') throw new Error('[bri-product] providerName "runtime" is reserved');
  const here = dirname(fileURLToPath(import.meta.url));
  const skillDir = typeof config.skillDir === 'string' && config.skillDir.length > 0
    ? resolve(config.skillDir)
    : resolve(here, 'skills');
  const providerName = config.providerName ?? PROVIDER_NAME;
  const rank = config.rank ?? DEFAULT_RANK;
  if (!Number.isInteger(rank) || rank < 0) throw new Error('[bri-product] config.rank must be a non-negative integer');
  ctx.logger.info(`[bri-product] skill provider "${providerName}" -> ${skillDir}`);
  ctx.effect(() => ctx.skills.registerProvider(() => new DirectorySkillProvider({
    logger: ctx.logger,
    providerName,
    skillDir,
    rank,
  })));
}

export default { name, inject, apply };
