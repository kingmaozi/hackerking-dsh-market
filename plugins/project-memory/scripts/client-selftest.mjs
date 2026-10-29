import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Dependency-free hook harness: executes the actual registered component and effects.
// It tests state transitions/element semantics, not browser layout or visual rendering.
let descriptor, registration, Component, cursor = 0, dirty = false, tree;
const cells = [], effects = [], requests = [], styles = [];
const React = {
  Fragment: 'fragment',
  createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter(child => child !== null && child !== false && child !== undefined) }; },
  useState(initial) {
    const index = cursor++;
    if (!cells[index]) cells[index] = { value: typeof initial === 'function' ? initial() : initial };
    return [cells[index].value, value => { cells[index].value = typeof value === 'function' ? value(cells[index].value) : value; dirty = true; }];
  },
  useRef(initial) { const index = cursor++; return (cells[index] ||= { current: initial }); },
  useId() { const index = cursor++; return 'pm-test-' + index; },
  useEffect(run, deps) {
    const index = cursor++;
    const prior = cells[index];
    if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) {
      cells[index] = { deps, cleanup: prior?.cleanup };
      effects.push(() => { cells[index].cleanup?.(); cells[index].cleanup = run(); });
    }
  }
};
vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(value) { descriptor = value; } } },
  document: {
    createElement(type) { assert.equal(type, 'style'); return { dataset: {}, remove() { styles.splice(styles.indexOf(this), 1); } }; },
    head: { appendChild(style) { styles.push(style); } }
  },
  fetch(url, init) { return new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })); }
});
assert.equal(descriptor.id, 'project-memory');
const plugin = descriptor.factory(name => { assert.equal(name, 'react'); return React; });
assert.deepEqual([...plugin.inject], ['slots']);
const disposers = [];
const ctx = {
  effect(run) { disposers.push(run()); },
  slots: {
    inject(name, register) { assert.equal(name, 'settings.section'); register(); },
    register(options, component) { registration = options; Component = component; assert.equal(typeof component, 'function'); }
  }
};
assert.equal(styles.length, 0, 'factory must not mutate DOM');
plugin.apply(ctx);
assert.equal(registration.id, 'project-memory');
assert.equal(registration.label, '记忆');
assert.equal(registration.order, 65);
assert.equal(styles.length, 1);
assert.equal(styles[0].dataset.plugin, 'project-memory');
assert.match(styles[0].textContent, /font-family:inherit;font-size:14px/);
assert.match(styles[0].textContent, /@container pm-settings \(max-width:440px\)/);
assert.match(styles[0].textContent, /:focus-visible/);
assert.match(styles[0].textContent, /--dsw-alias-label-primary/);
assert.match(styles[0].textContent, /prefers-reduced-motion/);

function render() {
  do {
    dirty = false; cursor = 0; tree = Component();
    effects.splice(0).forEach(run => run());
  } while (dirty);
  return tree;
}
async function settle() { for (let i = 0; i < 8; i++) { await Promise.resolve(); if (dirty) render(); } }
function nodes(node = tree) { return typeof node === 'object' ? [node, ...node.children.flatMap(child => nodes(child))] : []; }
function text(node = tree) { return typeof node === 'object' ? node.children.map(text).join('') : String(node); }
function get(predicate) { const node = nodes().find(predicate); assert.ok(node, 'expected element'); return node; }
function label(value) { return get(node => node.props['aria-label'] === value); }
function byClass(value) { return get(node => node.props.className === value); }
function respond(path, data, ok = true) {
  const index = requests.findIndex(request => request.url.endsWith(path));
  assert.notEqual(index, -1, 'expected request: ' + path);
  const [request] = requests.splice(index, 1);
  request.resolve({ ok, status: ok ? 200 : 500, json: async () => data });
  return request;
}
const projects = [{ id: 'a', title: 'Project A' }, { id: 'b', title: 'Project B' }];
const alpha = { title: 'Alpha', body: 'alpha commands', timestamp: '2026-10-21T10:00:00Z' };
const beta = { title: 'Beta', body: 'beta convention', timestamp: '2026-10-22T10:00:00Z' };
const memory = (entries = [alpha, beta], id = 'a') => ({ id, enabled: true, file: '/private/project/.dsh/memory/example.md', entries });
render();
assert.match(text(), /正在加载记忆/);
respond('workspaces', { projects, csrfToken: 'csrf-1' }); await settle();
respond('memory?id=a', memory()); await settle();
assert.equal(label('启用此项目记忆').props.role, 'switch');
assert.equal(label('启用此项目记忆').props['aria-checked'], true);
assert.equal(label('搜索记忆').props.type, 'search');
assert.equal(label('记忆详情').children[0].children[0].children[0], 'Alpha');
assert.ok(!text().includes('/private/project'), 'path collapsed by default');
byClass('pm-storage-toggle').props.onClick(); render();
assert.match(text(), /\/private\/project/);

// Search must preserve identity, not reinterpret filtered index as a different entry.
const entry = title => get(node => node.props.className === 'pm-entry' && text(node).includes(title));
entry('Beta').props.onClick(); render();
label('搜索记忆').props.onChange({ target: { value: 'beta' } }); render();
assert.match(text(label('记忆详情')), /beta convention/);
label('搜索记忆').props.onChange({ target: { value: 'alpha' } }); render();
assert.match(text(label('记忆详情')), /alpha commands/);
label('搜索记忆').props.onChange({ target: { value: 'no match' } }); render();
assert.match(text(), /没有匹配的记忆/);
label('搜索记忆').props.onChange({ target: { value: '' } }); render();
assert.match(text(label('记忆详情')), /beta convention/);
byClass('pm-detail-toggle').props.onClick(); render();
assert.equal(byClass('pm-detail-body').props['data-open'], false);

// Duplicate gestures join the single mutation; payload and CSRF contract stay unchanged.
const toggle = label('启用此项目记忆').props.onClick;
const firstToggle = toggle(); const secondToggle = toggle();
assert.equal(requests.filter(request => request.init?.method === 'POST').length, 1);
render();
assert.equal(label('记忆工作区').props.disabled, true);
const write = respond('enabled', { enabled: false });
assert.equal(write.init.headers['x-project-memory-csrf'], 'csrf-1');
assert.deepEqual(JSON.parse(write.init.body), { id: 'a', enabled: false });
await Promise.all([firstToggle, secondToggle]); await settle();
assert.equal(label('启用此项目记忆').props['aria-checked'], false);

// Two refreshes out of order: old catalog/read never overwrite the newer result.
label('刷新记忆').props.onClick(); render();
respond('workspaces', { projects, csrfToken: 'csrf-old' }); await settle();
label('刷新记忆').props.onClick(); render();
respond('workspaces', { projects: [projects[1]], csrfToken: 'csrf-new' }); await settle();
respond('memory?id=b', memory([beta], 'b')); await settle();
respond('memory?id=a', memory([alpha])); await settle();
assert.equal(label('记忆工作区').props.value, 'b');
assert.match(text(label('记忆详情')), /beta convention/);
assert.ok(!text(label('记忆详情')).includes('alpha commands'));

// Superseded catalog responses must not replace options or trigger extra reads.
label('刷新记忆').props.onClick(); render();
const staleCatalog = requests.shift();
assert.ok(staleCatalog.url.endsWith('workspaces'));
label('刷新记忆').props.onClick(); render();
respond('workspaces', { projects: [projects[1]], csrfToken: 'latest-catalog' }); await settle();
respond('memory?id=b', memory([beta], 'b')); await settle();
staleCatalog.resolve({ ok: true, json: async () => ({ projects: [projects[0]], csrfToken: 'stale-catalog' }) });
await settle();
assert.equal(label('记忆工作区').props.value, 'b');
assert.equal(requests.length, 0);

// Selected workspace stays selected when the refreshed catalog order changes.
label('刷新记忆').props.onClick(); render();
respond('workspaces', { projects, csrfToken: 'keep-b' }); await settle();
respond('memory?id=b', memory([beta], 'b')); await settle();
assert.equal(label('记忆工作区').props.value, 'b');

// Selected row survives insertion/reordering on refresh; identical duplicates have unique keys.
label('记忆工作区').props.onChange({ target: { value: 'a' } }); render();
respond('workspaces', { projects, csrfToken: 'csrf-2' }); await settle();
respond('memory?id=a', memory()); await settle();
entry('Beta').props.onClick(); render();
label('刷新记忆').props.onClick(); render();
respond('workspaces', { projects, csrfToken: 'csrf-2' }); await settle();
respond('memory?id=a', memory([beta, alpha, alpha])); await settle();
assert.match(text(label('记忆详情')), /beta convention/);
const keys = byClass('pm-list').children.map(node => node.props.key);
assert.equal(new Set(keys).size, 3);

// An explicitly selected A can disappear, fall back to B, then return.
// Selecting A again must fetch even though requestedId was already A before fallback.
label('刷新记忆').props.onClick(); render();
respond('workspaces', { projects: [projects[1]], csrfToken: 'fallback-b' }); await settle();
respond('memory?id=b', memory([beta], 'b')); await settle();
label('刷新记忆').props.onClick(); render();
respond('workspaces', { projects, csrfToken: 'restore-a' }); await settle();
respond('memory?id=b', memory([beta], 'b')); await settle();
label('记忆工作区').props.onChange({ target: { value: 'a' } }); render();
respond('workspaces', { projects, csrfToken: 'reselect-a' }); await settle();
respond('memory?id=a', memory()); await settle();
assert.equal(label('记忆工作区').props.value, 'a');
assert.match(text(label('记忆详情')), /alpha commands/);

// Workspace switch resets search and collapse state; stale failures are discarded.
label('搜索记忆').props.onChange({ target: { value: 'alpha' } }); render();
label('记忆工作区').props.onChange({ target: { value: 'b' } }); render();
respond('workspaces', { projects, csrfToken: 'csrf-3' }); await settle();
respond('memory?id=b', memory([], 'b')); await settle();
assert.equal(label('搜索记忆').props.value, '');
assert.match(text(), /这个项目尚无记忆/);
label('刷新记忆').props.onClick(); render();
respond('workspaces', { error: 'fixture failure' }, false); await settle();
assert.match(text(get(node => node.props.role === 'alert')), /fixture failure/);
label('刷新记忆').props.onClick(); render();
respond('workspaces', { projects: [], csrfToken: 'csrf-4' }); await settle();
assert.match(text(), /还没有项目工作区/);
assert.ok(!nodes().some(node => node.props.role === 'alert'));

// Effect cleanup ignores a late response after unmount.
label('刷新记忆').props.onClick(); render();
for (const cell of cells) cell?.cleanup?.();
dirty = false;
respond('workspaces', { projects, csrfToken: 'late' }); await settle();
assert.equal(dirty, false);
assert.equal(requests.length, 0, 'unmounted component must not continue to memory read');
disposers.splice(0).forEach(dispose => dispose?.());
assert.equal(styles.length, 0, 'plugin dispose removes only its own style');
plugin.apply(ctx);
assert.equal(styles.length, 1, 'reapply mounts fresh style');
disposers.splice(0).forEach(dispose => dispose?.());
assert.equal(styles.length, 0);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
assert.equal(pkg.exports['./client'], './lib/client.js');
assert.equal(pkg.dsh.client.platform, 'web');
console.log('PASS: actual __ModuleLoader__ factory shape, React dependency, settings.section registration and package client metadata');
console.log('PASS: scoped CSS apply/dispose/reapply, theme/responsive/focus declarations, loading/error/empty states, switch CSRF + duplicate-write guard, search/selection/duplicate identity, stale refresh + unmount guards');
console.log('NOTE: hook harness is not a DOM/browser renderer; live layout, keyboard and dark-theme visual acceptance remain environment-blocked.');
