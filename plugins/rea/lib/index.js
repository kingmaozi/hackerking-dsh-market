import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from './provider.js';

export const name = 'rea';
export const inject = ['skills'];

const PROVIDER_NAME = 'rea';
const DEFAULT_RANK = 450;

export function resolveSkillDir(configured) {
  if (typeof configured === 'string' && configured.length > 0) return resolve(configured);
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'skills');
}

export function apply(ctx, config = {}) {
  const skillDir = resolveSkillDir(config.skillDir);
  const providerName = config.providerName ?? PROVIDER_NAME;
  if (providerName === 'runtime') throw new Error('[rea] providerName "runtime" is reserved');

  ctx.logger.info(`[rea] skill provider "${providerName}" -> ${skillDir}`);
  ctx.effect(() => ctx.skills.registerProvider(() => new DirectorySkillProvider({
    logger: ctx.logger,
    providerName,
    skillDir,
    rank: config.rank ?? DEFAULT_RANK,
  })));
}

export default { name, inject, apply };
