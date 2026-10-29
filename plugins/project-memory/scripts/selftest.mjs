#!/usr/bin/env node
/**
 * selftest.mjs — mount `project-memory` against a fake host context and
 * prove the contract properties without booting DSH:
 *
 *   1. the skill provider lists `project-memory` and loads the current
 *      project's memory body;
 *   2. memory written under project A is invisible from project B, including
 *      when both projects share one absolute `memoryRoot`;
 *   3. write / status / skill all agree on the memory attribution root: a
 *      marker-less workspace under a `$HOME` that itself carries `.dsh` and
 *      `package.json` writes inside itself, never into `$HOME/.dsh/memory/`.
 *
 * Usage: node plugins/project-memory/scripts/selftest.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { apply } from '../lib/index.js';
import { effectiveProjectRoot } from '../lib/store.js';

const logger = {
  info: () => {},
  warn: (message) => console.error('WARN', message),
  debug: () => {},
};

async function makeProject(name) {
  const dir = await mkdtemp(join(tmpdir(), `dsh-memory-${name}-`));
  await mkdir(join(dir, '.git'), { recursive: true });
  await writeFile(join(dir, 'README.md'), `# ${name}\n`, 'utf8');
  return realpath(dir);
}

/** 目录里是否有记忆 Markdown（目录不存在也算"没有"）。 */
async function hasMarkdown(dir) {
  try {
    return (await readdir(dir)).some((name) => name.endsWith('.md'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

const projectA = await makeProject('a');
const projectB = await makeProject('b');

let registeredCwd = projectA;
const registered = [];
const providers = [];

const workingDirectory = { ensure: async () => registeredCwd };

const ctx = {
  logger,
  effect(fn) {
    return fn();
  },
  get(service) {
    if (service === 'tools') {
      return {
        register(definition) {
          registered.push(definition);
          return () => {};
        },
      };
    }
    if (service === 'workingDirectory') return workingDirectory;
    return undefined;
  },
  skills: {
    registerProvider(create) {
      providers.push(create({ signal: new AbortController().signal, invalidate() {} }));
      return () => {};
    },
  },
};

apply(ctx, {});

assert.equal(providers.length, 1, 'expected exactly one skill provider');
assert.equal(registered.length, 3, 'expected memory_write/memory_read/memory_status');
assert.deepEqual(registered.map((tool) => tool.name).sort(), ['memory_read', 'memory_status', 'memory_write']);

const provider = providers[0];
const tools = new Map(registered.map((tool) => [tool.name, tool]));

const exec = { agent: { id: 'fake-agent' }, signal: new AbortController().signal };

// ---------------------------------------------------------------- empty state
{
  const candidates = await provider.list({ cwd: projectA });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, 'project-memory');
  const body = await provider.get(candidates[0], { cwd: projectA });
  assert.match(body.content, /尚无记忆/);
}

// ------------------------------------------------------------ write in A only
{
  const result = await tools.get('memory_write').execute({
    text: 'A 项目的结论：CHECK_FN 在 0x100003a40，改 0x74 -> 0xeb 后许可证校验通过。',
    title: 'license check offset',
    source: 'selftest',
  }, exec);
  assert.equal(result.project, resolve(projectA));
  assert.ok(result.path.startsWith(join(projectA, '.dsh', 'memory')), `unexpected path ${result.path}`);
  assert.equal(result.entries, 1);
  const raw = await readFile(result.path, 'utf8');
  assert.match(raw, /project-memory\/v1/);
  assert.match(raw, /license check offset/);
}

// ------------------------------------------- provider sees A, B stays empty
{
  const listA = await provider.list({ cwd: projectA });
  const bodyA = await provider.get(listA[0], { cwd: projectA });
  assert.match(bodyA.content, /0x100003a40/);
  assert.match(bodyA.content, /条目数：1/);

  const listB = await provider.list({ cwd: projectB });
  assert.equal(listB[0].locator.slug === listA[0].locator.slug, false, 'slugs must differ per project');
  const bodyB = await provider.get(listB[0], { cwd: projectB });
  assert.doesNotMatch(bodyB.content, /0x100003a40/, 'project B must not see project A memory');

  registeredCwd = projectB;
  const readB = await tools.get('memory_read').execute({}, exec);
  assert.equal(readB.entries, 0);
  assert.equal(readB.content, '');
  assert.match(readB.path, new RegExp(`${projectB.split('/').pop().toLowerCase()}-[0-9a-f]{16}\\.md$`));

  const statusB = await tools.get('memory_status').execute({}, exec);
  assert.equal(statusB.exists, false);
  assert.deepEqual(statusB.files, []);
}

// ------------------------------------------- write in B, both coexist on disk
{
  registeredCwd = projectB;
  await tools.get('memory_write').execute({ text: 'B 项目：另一套样本，保持独立。' }, exec);
  const statusB = await tools.get('memory_status').execute({}, exec);
  assert.equal(statusB.entries, 1);

  registeredCwd = projectA;
  const readA = await tools.get('memory_read').execute({}, exec);
  assert.equal(readA.entries, 1);
  assert.match(readA.content, /license check offset/);
  assert.doesNotMatch(readA.content, /另一套样本/);

  const filtered = await tools.get('memory_read').execute({ section: '不存在' }, exec);
  assert.equal(filtered.entries, 0);
}

// ------------------------------- shared absolute memoryRoot still隔离 by slug
{
  const sharedRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-memory-shared-')));
  const sharedTools = [];
  const localProviders = [];
  const isolatedCtx = {
    logger,
    effect(fn) {
      return fn();
    },
    get(service) {
      if (service === 'tools') {
        return {
          register(definition) {
            sharedTools.push(definition);
            return () => {};
          },
        };
      }
      if (service === 'workingDirectory') return { ensure: async () => projectA };
      return undefined;
    },
    skills: {
      registerProvider(create) {
        localProviders.push(create({ signal: new AbortController().signal, invalidate() {} }));
        return () => {};
      },
    },
  };
  apply(isolatedCtx, { memoryRoot: sharedRoot });
  const sharedProvider = localProviders[0];
  const sharedWrite = sharedTools.find((tool) => tool.name === 'memory_write');
  await sharedWrite.execute({ text: 'shared root entry for A only' }, exec);
  const aList = await sharedProvider.list({ cwd: projectA });
  const aBody = await sharedProvider.get(aList[0], { cwd: projectA });
  assert.match(aBody.content, /shared root entry for A only/);
  assert.ok(aBody.content.includes(sharedRoot));
  const bList = await sharedProvider.list({ cwd: projectB });
  const bBody = await sharedProvider.get(bList[0], { cwd: projectB });
  assert.doesNotMatch(bBody.content, /shared root entry for A only/);
  await rm(sharedRoot, { recursive: true, force: true });
}

// ---------------- 无 marker 子项目：写入/状态/技能都归属它自己，不被 $HOME 抢占
{
  const savedHome = process.env.HOME;
  const savedDshHome = process.env.DSH_HOME;
  const fakeHome = await realpath(await mkdtemp(join(tmpdir(), 'dsh-memory-home-')));
  const child = join(fakeHome, 'projects', 'no-marker');
  const gitChild = join(fakeHome, 'projects', 'with-git');
  try {
    // 仿真的家目录：`.dsh` + `package.json` 正是"家目录抢占"的成因。
    await mkdir(join(fakeHome, '.dsh'), { recursive: true });
    await writeFile(join(fakeHome, 'package.json'), '{"name":"fake-home"}\n', 'utf8');
    await mkdir(child, { recursive: true });
    await mkdir(join(gitChild, '.git'), { recursive: true });
    process.env.HOME = fakeHome;
    process.env.DSH_HOME = join(fakeHome, '.dsh');

    // 带 marker 的项目行为不变：包括家目录里的 `.git` 仓库。
    assert.equal(await effectiveProjectRoot(projectA), projectA, '带 .git 的项目仍解析到自身');
    assert.equal(await effectiveProjectRoot(gitChild), gitChild, '家目录下的 .git 仓库仍解析到自身');

    registeredCwd = child;
    const written = await tools.get('memory_write').execute({
      text: '无 marker 子项目：写入必须归属它自己，不能落到 $HOME。',
      title: 'no-marker write',
      source: 'selftest',
    }, exec);
    // a) 项目根是子项目自身，不是 $HOME。
    assert.equal(written.project, child, `memory_write 的项目根必须是子项目自身，实际 ${written.project}`);
    // b) 文件落在 <子项目>/.dsh/memory/<basename>-<sha256(abs)[:16]>.md
    const expectedHash = createHash('sha256').update(child).digest('hex').slice(0, 16);
    assert.equal(written.path, join(child, '.dsh', 'memory', `no-marker-${expectedHash}.md`));
    assert.equal(written.path.startsWith(join(child, '.dsh', 'memory') + sep), true, `记忆文件必须在子项目内，实际 ${written.path}`);
    // c) $HOME 的 .dsh/memory 下没有新建任何 .md。
    assert.equal(await hasMarkdown(join(fakeHome, '.dsh', 'memory')), false, '临时 HOME 的 .dsh/memory 下不得新建 .md');
    assert.equal(await readFile(written.path, 'utf8').then((raw) => raw.includes('no-marker write')), true);
    // d) 同一 cwd 下 memory_status 与 memory_write 同根同文件。
    const status = await tools.get('memory_status').execute({}, exec);
    assert.equal(status.project, written.project, 'memory_status 与 memory_write 必须同根');
    assert.equal(status.path, written.path);
    assert.equal(status.entries, 1);
    // e) 技能 provider（面板/技能面）与工具同根，并能读到刚写入的条目。
    const list = await provider.list({ cwd: child });
    assert.equal(list.length, 1);
    assert.equal(list[0].locator.root, child, '技能 provider 的 locator.root 必须与工具同根');
    assert.equal(list[0].locator.file, written.path);
    const body = await provider.get(list[0], { cwd: child });
    assert.match(body.content, /no-marker write/, '技能正文必须读到刚写的那条');
    assert.ok(body.content.includes(written.path));

    // 走工具家族之外也不漏：memory_read 从同一 cwd 读回同一条。
    const readBack = await tools.get('memory_read').execute({}, exec);
    assert.equal(readBack.project, child);
    assert.equal(readBack.path, written.path);
    assert.match(readBack.content, /no-marker write/);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
    registeredCwd = projectA;
    await rm(fakeHome, { recursive: true, force: true });
  }
}

console.log('OK project-memory: provider + 3 tools, project A/B isolated');
console.log('OK 无 marker 子项目：memory_write/status/read 与技能 provider 同根，未落到 $HOME/.dsh/memory');
console.log(`  A memory: ${join(projectA, '.dsh', 'memory')}`);
console.log(`  B memory: ${join(projectB, '.dsh', 'memory')}`);

await rm(projectA, { recursive: true, force: true });
await rm(projectB, { recursive: true, force: true });
