import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from './provider.js';

export const name = 'crack-lab';
export const inject = ['skills'];

const PROVIDER_NAME = 'crack-lab';
const DEFAULT_RANK = 450;

export function apply(ctx, config = {}) {
  if (config.providerName === 'runtime') throw new Error('[crack-lab] providerName "runtime" is reserved');
  const here = dirname(fileURLToPath(import.meta.url));
  const skillDir = typeof config.skillDir === 'string' && config.skillDir.length > 0
    ? resolve(config.skillDir)
    : resolve(here, '..', 'skills');
  const providerName = config.providerName ?? PROVIDER_NAME;
  ctx.logger.info(`[crack-lab] skill provider "${providerName}" -> ${skillDir}`);
  ctx.effect(() => ctx.skills.registerProvider(() => new DirectorySkillProvider({
    logger: ctx.logger,
    providerName,
    skillDir,
    rank: config.rank ?? DEFAULT_RANK,
  })));
}

export default { name, inject, apply };
