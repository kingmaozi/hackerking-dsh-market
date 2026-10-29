import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from '../lib/provider.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const provider = new DirectorySkillProvider({
  logger: { warn: (message) => console.error('WARN', message), debug: () => {} },
  providerName: 'reverse-skills',
  skillDir: resolve(root, 'skills'),
  rank: 450,
});

const candidates = await provider.list();
if (candidates.length !== 46) {
  console.error(`expected 46 skills, got ${candidates.length}`);
  process.exit(1);
}
if (!candidates.some((skill) => skill.name === 'reverse-skill-router')) {
  console.error('reverse-skill-router missing');
  process.exit(1);
}
for (const candidate of candidates) {
  const loaded = await provider.get(candidate);
  if (loaded === undefined || loaded.content.length < 80) {
    console.error(`failed to load ${candidate.name}`);
    process.exit(1);
  }
  if (loaded.name !== candidate.name) {
    console.error(`name drift for ${candidate.name}`);
    process.exit(1);
  }
}
const names = new Set(candidates.map((skill) => skill.name));
console.log(`OK ${candidates.length} skills loaded; router=${names.has('reverse-skill-router')}`);
