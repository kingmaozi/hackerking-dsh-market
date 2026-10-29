import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from '../lib/provider.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const provider = new DirectorySkillProvider({
  logger: { warn: (message) => console.error('WARN', message), debug: () => {} },
  providerName: 'ghidra-bridge',
  skillDir: resolve(root, 'skills'),
  rank: 450,
});
const candidates = await provider.list();
if (candidates.length !== 1 || candidates[0].name !== 'ghidra-bridge') {
  console.error(`unexpected catalog: ${candidates.map((skill) => skill.name).join(', ')}`);
  process.exit(1);
}
const loaded = await provider.get(candidates[0]);
if (loaded === undefined || loaded.content.length < 500) {
  console.error('failed to load ghidra-bridge');
  process.exit(1);
}
console.log(`OK ${loaded.name}: ${loaded.content.length} chars`);
