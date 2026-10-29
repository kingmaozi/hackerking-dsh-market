import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from '../lib/provider.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const provider = new DirectorySkillProvider({
  logger: { warn: (message) => console.error('WARN', message), debug: () => {} },
  providerName: 'crack-lab',
  skillDir: resolve(root, 'skills'),
  rank: 450,
});
const candidates = await provider.list();
const expected = ['apk-crack', 'crack-intake', 'crack-report', 'crack-router', 'keygen-model', 'license-patch', 'native-unpack'];
for (const name of expected) {
  if (!candidates.some((skill) => skill.name === name)) {
    console.error(`missing ${name}`);
    process.exit(1);
  }
}
for (const candidate of candidates) {
  const loaded = await provider.get(candidate);
  if (loaded === undefined || loaded.content.length < 500) {
    console.error(`failed to load ${candidate.name}`);
    process.exit(1);
  }
}
console.log(`OK ${candidates.length} skills: ${candidates.map((skill) => skill.name).join(', ')}`);
