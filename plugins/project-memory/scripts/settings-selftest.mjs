import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer, get as httpGet } from 'node:http';
import { appendProjectMemory, readProjectMemory, resolveMemoryPaths } from '../lib/store.js';
import { memoryEnabled, setMemoryEnabled } from '../lib/settings.js';
import { ProjectMemoryProvider } from '../lib/provider.js';
import { createMemoryTools } from '../lib/tools.js';
import { createMemoryRoute } from '../lib/web.js';

const root = resolve('work/memory-settings/test-fixtures-' + Date.now());
const a = join(root, 'a'), b = join(root, 'b'), outside = join(root, 'outside');
for (const project of [a, b, outside]) await mkdir(join(project, '.git'), { recursive: true });
await Promise.all(Array.from({ length: 32 }, (_, index) => appendProjectMemory(a, { text: 'entry-' + index })));
assert.equal((await readProjectMemory(a)).entries.length, 32, 'parallel first writes retained');
assert.equal((await readProjectMemory(b)).entries.length, 0);
const before = (await readProjectMemory(a)).content;
await setMemoryEnabled(a, false);
assert.equal(await memoryEnabled(a), false); assert.equal(await memoryEnabled(b), true);
await assert.rejects(appendProjectMemory(a, { text: 'blocked' }), /停用/);
const provider = new ProjectMemoryProvider({ providerName: 'test', logger: console });
assert.deepEqual(await provider.list({ cwd: a }), []);
await assert.rejects(provider.get({}, { cwd: a }), /停用/);
const tools = createMemoryTools({ ctx: { get: () => ({ ensure: async () => a }) } });
for (const tool of tools) await assert.rejects(tool.execute({ text: 'blocked' }, { agent: {} }), /停用/);
assert.equal((await readProjectMemory(a)).content, before, 'disable preserves original memory');
assert.equal((await provider.list({ cwd: b })).length, 1);
await setMemoryEnabled(a, true);
assert.equal(await memoryEnabled(a), true);
assert.equal((await provider.list({ cwd: a })).length, 1);
assert.equal((await provider.get((await provider.list({ cwd: a }))[0], { cwd: b })).content.includes('entry-'), false, 'cached candidate cannot cross cwd');

let origin; let invalidations = 0;
const route = createMemoryRoute({ workspaces: () => [{ id: 'a', path: a, title: 'A' }, { id: 'b', path: b, title: 'B' }], origin: () => origin, invalidate: () => invalidations++ });
// Match the actual host's segment-boundary prefix contract, not just handler calls.
assert.equal(route.path, '/api/project-memory');
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === route.path || pathname.startsWith(`${route.path}/`)) return route.handler(req, res);
  res.writeHead(404); res.end('unmatched host route');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
origin = 'http://127.0.0.1:' + server.address().port;
try {
 const get = (path, headers) => fetch(origin + '/api/project-memory/' + path, { headers });
 const list = await (await get('workspaces')).json();
 assert.equal(list.projects.length, 2);
 assert.equal((await get('memory?id=' + encodeURIComponent(outside))).status, 403);
 assert.equal((await get('memory?id=a', { origin: 'https://evil.example' })).status, 403);
 assert.equal(await new Promise((done, fail) => { httpGet(origin + '/api/project-memory/workspaces', { headers: { host: 'evil.example' } }, response => { response.resume(); done(response.statusCode); }).on('error', fail); }), 403);
 const post = (body, headers = {}) => fetch(origin + '/api/project-memory/enabled', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
 assert.equal((await post({ id: 'a', enabled: false })).status, 403);
 assert.equal((await post({ id: 'a', enabled: false }, { origin, 'x-project-memory-csrf': 'wrong' })).status, 403);
 const headers = { origin, 'x-project-memory-csrf': list.csrfToken };
 assert.equal((await post({ id: 'a', enabled: false }, headers)).status, 200);
 assert.equal(await memoryEnabled(b), true); assert.equal(await memoryEnabled(a), false);
 assert.equal((await get('memory?id=a')).status, 200, 'human inspection retained when disabled');
 assert.equal((await post({ id: 'a', enabled: 'false' }, headers)).status, 400);
 assert.equal((await post({ id: outside, enabled: true }, headers)).status, 403);
 assert.equal((await post({ id: 'a', enabled: true }, headers)).status, 200);
 assert.equal(invalidations, 2);
 // Traversal of a symlinked canonical file must fail, even for registered roots.
 const bp = await resolveMemoryPaths(b);
 await mkdir(bp.dir, { recursive: true });
 await writeFile(join(outside, 'secret.md'), 'secret');
 await symlink(join(outside, 'secret.md'), bp.file);
 assert.equal((await get('memory?id=b')).status, 400);
 await assert.rejects(appendProjectMemory(b, { text: 'leak' }), /symlink/);
 assert.equal(await readFile(join(outside, 'secret.md'), 'utf8'), 'secret');
 const c = join(root, 'c'); await mkdir(join(c, '.git'), { recursive: true });
 await symlink(outside, join(c, '.dsh'));
 await assert.rejects(setMemoryEnabled(c, false), /symlink/);
 console.log('PASS: 32 concurrent first writes; A/B isolation; persistent switch; all 3 tools and skill gated; cached-candidate isolation; registered-only API; Host/Origin/CSRF; invalid boolean; symlink file/parent; bytes preserved');
 console.log('fixtures:', root);
} finally { await new Promise(done => server.close(done)); }
