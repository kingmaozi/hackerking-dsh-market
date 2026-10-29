#!/usr/bin/env node
/**
 * hub-regression.mjs — 记忆归属根 / 工作区枚举回归。
 *
 * 修复前的两个症状：
 *   A. `resolveProjectRoot` 向上找 `.git`→`.dsh`→`package.json`，而 `$HOME` 自己
 *      就带 `.dsh` 与 `package.json` → 家目录抢占没有 marker 的子目录（`~/Documents/zuli`
 *      明明有 `package.json` 也落到 `$HOME`）。16 个注册工作区里 14 个解析到家目录。
 *   B. `web.js` 用 `resolveProjectRoot(path) !== path` 直接丢弃 → API 只剩 2 行；
 *      `overview()` 不过滤 → 16 行；同一注册表两个口径。
 *
 * 本脚本覆盖：
 *   1. 临时 HOME 带 `.dsh` + `package.json` 时，无 marker 与自带 `package.json` 的子目录都不被抢占；
 *   2. 起点自身是 HOME / DSH_HOME 时返回自身（家目录开会话仍是一个项目）；
 *   3. 真嵌套（父目录有 `.git` 且父目录是注册工作区）仍折叠为父级；根不是注册工作区时保留自己的行；
 *   4. `overview()` 与 web API（`hub.listManageableWorkspaces`）对同一注册表返回一致的行集合；
 *   5. B1/m4/m7–m11 回归：`.dsh` 只有 memory 不算声明、父级开关/写入不折叠子行、
 *      折叠根可读可写、shared memoryRoot 不跨项目、EACCES 不丢行、`~/.dsh` symlink、
 *      `.dsh` 普通文件、`exists` 只认 canonical；
 *   6. 真实 `$DSH_HOME/storages/workspace.json` 只读跑一次：**软断言**——注册表存在时校验
 *      overview / 枚举 / 真实 API 的 path 集合一致、self-rooted 行不丢、hackerking（若存在）
 *      的 entries 与 store 实读一致；注册表为空/不可读时打印 SKIP 而不是失败。
 *
 * 夹具全部在 `os.tmpdir()` 内；真实注册表与 `~/.dsh` 只读（跑完比对字节与目录快照）。
 * `process.env.HOME` / `DSH_HOME` 只在临时夹具期间替换，`finally` 恢复；
 * 权限夹具（chmod 000）用完在 finally 里恢复，避免 tmp 清理失败。
 *
 * Usage: node plugins/project-memory/scripts/hub-regression.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  appendProjectMemory,
  effectiveProjectRoot,
  readProjectMemory,
  resolveMemoryPaths,
  resolveProjectRoot,
} from '../lib/store.js';
import {
  appendToProject,
  dshHome,
  listManageableWorkspaces,
  listRegisteredWorkspaces,
  overview,
  readProject,
  workspaceRegistryPath,
} from '../lib/hub.js';
import { setMemoryEnabled } from '../lib/settings.js';
import { createMemoryRoute } from '../lib/web.js';

// ---------------------------------------------------------------- 环境快照
const realHome = homedir();
const realDshHome = dshHome();
const realDshHomeEnv = process.env.DSH_HOME;
const realHomeEnv = realHome;

/** 把测试夹具路径缩成 `~` 开头，输出更好读。 */
const pretty = (path) => (path.startsWith(realHome) ? `~${path.slice(realHome.length)}` : path);

/** 目录快照（文件名 + 大小 + mtime），用来证明枚举没有写盘。 */
async function snapshot(dir) {
  let names;
  try {
    names = (await readdir(dir)).sort();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return '(missing)';
    throw error;
  }
  const out = [];
  for (const name of names) {
    const info = await stat(join(dir, name));
    out.push(`${name}:${info.size}:${info.mtimeMs}`);
  }
  return out.join('\n');
}

/** 文件指纹（内容 sha256 + mtime），用来证明真实注册表只读。 */
async function fingerprint(file) {
  try {
    const [bytes, info] = [await readFile(file), await stat(file)];
    return `${createHash('sha256').update(bytes).digest('hex')}:${info.mtimeMs}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return '(missing)';
    throw error;
  }
}

const tempHome = await realpath(await mkdtemp(join(tmpdir(), 'pm-hub-home-')));
const tempDsh = join(tempHome, '.dsh');
const fixtures = [tempHome];
let server;
let origin;

try {
  // ------------------------------------------------ 夹具：仿真的 $HOME 布局
  await mkdir(tempDsh, { recursive: true });
  await writeFile(join(tempHome, 'package.json'), '{"name":"fake-home"}\n', 'utf8');
  // 家目录带 .dsh + package.json，正是抢占的成因（修复前从这里开始出错）。

  const plain = join(tempHome, 'projects', 'plain'); // 自身无 marker
  const withPkg = join(tempHome, 'projects', 'withpkg'); // 自带 package.json
  const deep = join(plain, 'deep', 'nested'); // 更深的无 marker 目录
  const parent = join(tempHome, 'repos', 'parent'); // 有 .git，且注册为工作区
  const child = join(parent, 'child'); // 无 marker → 折叠到 parent
  const pkgOnly = join(tempHome, 'work', 'pkg-only'); // 有 package.json，但**不**注册
  const pkgOnlySub = join(pkgOnly, 'sub'); // 注册 → 根落在未注册的 pkgOnly，保留自己的行
  const linkToPlain = join(tempHome, 'link-plain'); // symlink 拼写，与 plain 同根

  await mkdir(deep, { recursive: true });
  await mkdir(withPkg, { recursive: true });
  await writeFile(join(withPkg, 'package.json'), '{"name":"withpkg"}\n', 'utf8');
  await mkdir(join(parent, '.git'), { recursive: true });
  await mkdir(child, { recursive: true });
  await mkdir(pkgOnly, { recursive: true });
  await writeFile(join(pkgOnly, 'package.json'), '{"name":"pkg-only"}\n', 'utf8');
  await mkdir(pkgOnlySub, { recursive: true });
  await symlink(plain, linkToPlain);
  fixtures.push(plain, withPkg, parent, pkgOnly);

  // ------------------------------------ 1+2. HOME 不再是 marker：根不再被抢占
  process.env.HOME = tempHome;
  process.env.DSH_HOME = tempDsh;
  assert.equal(homedir(), tempHome, 'HOME 环境变量必须驱动 os.homedir()（否则夹具无效）');
  assert.equal(dshHome(), tempDsh, 'DSH_HOME 环境变量必须驱动 dshHome()');

  // legacy 语义保留（仍导出、仍按纯 pathExists 判定），也是"家目录抢占"的可复现证据。
  assert.equal(await resolveProjectRoot(plain), tempHome, 'resolveProjectRoot 语义不变：marker 向上找到 HOME');
  assert.equal(await resolveProjectRoot(withPkg), tempHome, '连自带 package.json 的子目录也被 HOME 抢（.dsh 先命中）');

  for (const [label, start] of [['无 marker', plain], ['自带 package.json', withPkg], ['深层无 marker', deep]]) {
    const root = await effectiveProjectRoot(start);
    assert.equal(root, start, `${label} 子目录必须归属自己，实际 ${root}`);
    assert.notEqual(root, tempHome, `${label} 子目录不能被 HOME 抢占`);
  }
  assert.equal(await effectiveProjectRoot(tempHome), tempHome, 'start 自身是 HOME 时返回 HOME');
  assert.equal(await effectiveProjectRoot(tempDsh), tempDsh, 'start 自身是 DSH_HOME 时返回 DSH_HOME');
  assert.equal(await effectiveProjectRoot(parent), parent, '带 .git 的仓库根与 resolveProjectRoot 结果一致');
  console.log('PASS 1/5 HOME 带 .dsh+package.json 时不抢占子目录（无 marker / 有 package.json / 深层），HOME/DSH_HOME 自身仍返回自身');

  // ------------------------------------------------ 3. 嵌套折叠 / 根去重 / symlink
  const registry = [
    { id: 'id-parent', path: parent, title: 'Parent' },
    { id: 'id-child', path: child, title: 'Child' },
    { id: 'id-plain', path: plain, title: 'Plain' },
    { id: 'id-link', path: linkToPlain, title: 'LinkPlain' },
    { id: 'id-pkg', path: withPkg, title: 'WithPkg' },
    { id: 'id-sub', path: pkgOnlySub, title: 'PkgOnlySub' },
    { id: 'id-ghost', path: join(tempHome, 'projects', 'ghost'), title: 'Ghost' }, // 不存在的路径
  ];
  const manageable = await listManageableWorkspaces({ workspaces: registry });
  const byRoot = new Map(manageable.map((row) => [row.path, row]));
  assert.equal(manageable.length, 4, `期望 4 行（parent/plain/withpkg/pkg-only），实际 ${manageable.length}`);
  assert.deepEqual(
    [...byRoot.keys()].sort(),
    [parent, plain, withPkg, pkgOnly].sort(),
    '行 path 必须是记忆归属根',
  );
  // 真嵌套：child 的解析根是注册工作区 parent → 折叠，父级 ID/标题取胜。
  assert.equal(byRoot.get(parent).id, 'id-parent');
  assert.equal(byRoot.get(parent).title, 'Parent');
  assert.equal(manageable.some((row) => row.id === 'id-child'), false, '嵌套工作区不得单独成行');
  // 多个工作区同根（symlink 拼写）只留一行，且取"根就是自己"的那一行的 ID。
  assert.equal(manageable.filter((row) => row.path === plain).length, 1);
  assert.equal(byRoot.get(plain).id, 'id-plain');
  // 解析根不是注册工作区（pkg-only）→ 保留自己的行，不折叠。
  assert.equal(byRoot.get(pkgOnly).id, 'id-sub');
  // 不存在的注册路径被跳过。
  assert.equal(manageable.some((row) => row.title === 'Ghost'), false);

  console.log(`PASS 2/5 嵌套折叠：${pretty(parent)} 1 行（child 折叠）· symlink 同根去重 · 未注册父根保留自己的行 · 幽灵路径跳过`);

  // 宿主 workspaceRegistry 实体只有 sessionIds（无 sessions）：live 路线下
  // 折叠行必须把子工作区的会话数累加进来，而不是恒为 0。
  const liveShaped = await listManageableWorkspaces({
    workspaces: [
      { id: 'id-parent', path: parent, title: 'Parent', sessionIds: ['s1', 's2', 's3'] },
      { id: 'id-child', path: child, title: 'Child', sessionIds: ['s4', 's5'] },
      { id: 'id-plain', path: plain, title: 'Plain', sessionIds: [] },
    ],
  });
  assert.equal(liveShaped.length, 2, `live 形态应折叠为 2 行，实际 ${liveShaped.length}`);
  assert.equal(liveShaped.find((row) => row.path === parent).sessions, 5, 'live 形态折叠行必须累加 sessionIds');
  assert.equal(liveShaped.find((row) => row.path === plain).sessions, 0);
  console.log(`PASS 2b/5 live 形态（只有 sessionIds）会话数累加：折叠行 sessions=5`);

  // ---- B1（review blocker）：父级开关 / 写入自造的 `<父>/.dsh/memory` 不是项目声明
  const b1Parent = join(tempHome, 'b1', 'parent');
  const b1Child = join(b1Parent, 'child');
  await mkdir(b1Child, { recursive: true });
  const b1Registry = [
    { id: 'id-b1-parent', path: b1Parent, title: 'B1Parent' },
    { id: 'id-b1-child', path: b1Child, title: 'B1Child' },
  ];
  const b1Paths = async () => (await listManageableWorkspaces({ workspaces: b1Registry })).map((row) => row.path).sort();
  const bothB1 = [b1Child, b1Parent].sort();

  assert.deepEqual(await b1Paths(), bothB1, 'B1 前置：父/子各一行');
  await setMemoryEnabled(b1Parent, false); // 生成 <父>/.dsh/memory/<slug>.settings.json
  assert.deepEqual(await b1Paths(), bothB1, 'B1：父级切开关后子行不得消失');
  await setMemoryEnabled(b1Parent, true);
  await appendProjectMemory(b1Parent, { text: 'B1 parent entry' }); // 生成 <父>/.dsh/memory/<slug>.md
  assert.deepEqual(await b1Paths(), bothB1, 'B1：父级写记忆后子行不得消失');
  assert.equal(await effectiveProjectRoot(b1Child), b1Child, '.dsh 只有 memory 时子目录仍归属自己');
  assert.equal(await resolveProjectRoot(b1Child), b1Parent, 'legacy resolveProjectRoot 仍把任何 .dsh 当 marker（语义未变）');

  // `.dsh` 里出现真正的项目声明（profile.yml / skills）才变回 marker。
  await writeFile(join(b1Parent, '.dsh', 'profile.yml'), 'name: b1\n', 'utf8');
  assert.equal(await effectiveProjectRoot(b1Child), b1Parent, '.dsh 带 profile.yml 时才是 marker');
  assert.deepEqual(await b1Paths(), [b1Parent], '.dsh 声明成项目后子行按设计折叠');

  // `.DS_Store` 之类噪声同样不算声明；`skills` 目录算。
  const dsStoreParent = join(tempHome, 'b1', 'dsstore-parent');
  const skillsParent = join(tempHome, 'b1', 'skills-parent');
  await mkdir(join(dsStoreParent, '.dsh'), { recursive: true });
  await writeFile(join(dsStoreParent, '.dsh', '.DS_Store'), '', 'utf8');
  await mkdir(join(dsStoreParent, 'leaf'), { recursive: true });
  await mkdir(join(skillsParent, '.dsh', 'skills'), { recursive: true });
  await mkdir(join(skillsParent, 'leaf'), { recursive: true });
  assert.equal(await effectiveProjectRoot(join(dsStoreParent, 'leaf')), join(dsStoreParent, 'leaf'), '.dsh 只有 .DS_Store 时不是 marker');
  assert.equal(await effectiveProjectRoot(join(skillsParent, 'leaf')), skillsParent, '.dsh/skills 算项目声明');

  // `.git` 与 `package.json` 判定保持原样。
  const gitParent = join(tempHome, 'b1', 'git-parent');
  const pkgParent = join(tempHome, 'b1', 'pkg-parent');
  await mkdir(join(gitParent, '.git'), { recursive: true });
  await mkdir(join(gitParent, 'leaf'), { recursive: true });
  await mkdir(pkgParent, { recursive: true });
  await writeFile(join(pkgParent, 'package.json'), '{"name":"pkg-parent"}\n', 'utf8');
  await mkdir(join(pkgParent, 'leaf'), { recursive: true });
  assert.equal(await effectiveProjectRoot(join(gitParent, 'leaf')), gitParent, '.git 仍是 marker');
  assert.equal(await effectiveProjectRoot(join(pkgParent, 'leaf')), pkgParent, 'package.json 仍是 marker');
  console.log('PASS 2c/5 B1：父级 setMemoryEnabled/memory_write 后行集合不变（.dsh 只有 memory/.DS_Store 不算 marker；profile.yml/skills 算；.git/package.json 不变）');

  // ---- m4：折叠根可读可写；shared 绝对 memoryRoot 下不跨项目读
  // b1Parent 此刻是 b1Child 的解析根，但只有 b1Child 注册 → 它就是折叠根。
  const foldedRead = await readProject(b1Parent, { allowedPaths: [b1Child] });
  assert.equal(foldedRead.path, b1Parent, '折叠根读记忆不得抛 project not in the workspace registry');
  assert.equal(foldedRead.entries.length, 1, '折叠根应读到父级自己那条记忆');
  assert.match(foldedRead.content, /B1 parent entry/);
  const foldedAppend = await appendToProject(b1Parent, { text: 'folded root append' }, { allowedPaths: [b1Child] });
  assert.equal(foldedAppend.entries, 2, '折叠根也必须可写');

  const sharedRoot = join(tempHome, 'shared-memory'); // 绝对 memoryRoot：两个项目共用一个目录
  const m4a = join(tempHome, 'm4', 'a');
  const m4b = join(tempHome, 'm4', 'b');
  const m4c = join(tempHome, 'm4', 'c');
  for (const dir of [m4a, m4b, m4c]) await mkdir(dir, { recursive: true });
  await appendProjectMemory(m4a, { text: 'A-only entry' }, { memoryRoot: sharedRoot });
  await appendProjectMemory(m4b, { text: 'B-only entry' }, { memoryRoot: sharedRoot });
  const m4Allowed = [m4a, m4b, m4c];
  const readA = await readProject(m4a, { memoryRoot: sharedRoot, allowedPaths: m4Allowed });
  assert.match(readA.content, /A-only entry/);
  assert.doesNotMatch(readA.content, /B-only entry/, 'shared memoryRoot 下不得读到别的项目');
  const readC = await readProject(m4c, { memoryRoot: sharedRoot, allowedPaths: m4Allowed });
  assert.equal(readC.exists, false);
  assert.equal(readC.content, '');
  assert.deepEqual(readC.entries, []);
  assert.ok(readC.files.length >= 2, '同目录里别项目的文件只能出现在文件列表，不能进正文');
  assert.equal(readC.file, join(sharedRoot, `${readC.slug}.md`), '没有 canonical 文件时只返回本项目目标路径');
  const sharedFiles = (await readdir(sharedRoot)).filter((name) => name.endsWith('.md')).sort();
  assert.equal(sharedFiles.length, 2, 'shared 目录里只有 A/B 两个文件');
  console.log(`PASS 2d/5 m4：折叠根可读可写（entries=${foldedAppend.entries}）· shared memoryRoot 下 A/B 互不可见、无 canonical 的项目返回空态`);

  // ---- m11：shared 绝对 memoryRoot 下 exists 只认本项目 canonical 文件
  const sharedOverview = await overview({
    workspacePaths: [{ path: m4a, title: 'SharedA' }, { path: m4c, title: 'SharedC' }],
    memoryRoot: sharedRoot,
  });
  const sharedRowA = sharedOverview.projects.find((row) => row.path === m4a);
  const sharedRowC = sharedOverview.projects.find((row) => row.path === m4c);
  assert.equal(sharedRowA.exists, true, 'A 有自己的 canonical 文件');
  assert.equal(sharedRowA.entries, 1);
  assert.equal(sharedRowC.exists, false, 'C 没有 canonical 文件：同目录里别项目的 md 不算它存在');
  assert.equal(sharedRowC.entries, 0);
  assert.ok(sharedRowC.files.length >= 2, 'C 的文件列表仍能看到同目录里的别项目文件');
  assert.equal(sharedOverview.withMemory, 1, 'withMemory 只能数本项目有文件的');
  console.log('PASS 2f/5 m11：shared memoryRoot 下 exists 只认 canonical，withMemory 不虚高');

  // ---- m7：`.dsh` 读不到（EACCES）不能让整行消失
  const m7Locked = join(tempHome, 'm7', 'locked');
  await mkdir(join(m7Locked, '.dsh'), { recursive: true });
  await writeFile(join(m7Locked, '.dsh', 'profile.yml'), 'name: locked\n', 'utf8');
  await chmod(join(m7Locked, '.dsh'), 0o000);
  try {
    const m7Rows = await listManageableWorkspaces({
      workspaces: [{ id: 'id-m7', path: m7Locked, title: 'Locked' }, { id: 'id-m7-plain', path: plain, title: 'PlainForM7' }],
    });
    assert.deepEqual(m7Rows.map((row) => row.path).sort(), [m7Locked, plain].sort(), 'm7：EACCES 不得丢整行');
    const lockedRow = m7Rows.find((row) => row.path === m7Locked);
    assert.equal(lockedRow.degraded, false, 'm7：declaresProject 保守返回 true，根仍算得出来');
    assert.equal(await effectiveProjectRoot(m7Locked), m7Locked, 'm7：读不到 .dsh 时按"有声明"处理');
  } finally {
    await chmod(join(m7Locked, '.dsh'), 0o755);
  }
  // 循环链接的 `.dsh`（ELOOP）同样不能把异常抛出去。
  const m7Loop = join(tempHome, 'm7', 'loop');
  await mkdir(m7Loop, { recursive: true });
  await symlink(join(m7Loop, '.dsh-b'), join(m7Loop, '.dsh'));
  await symlink(join(m7Loop, '.dsh'), join(m7Loop, '.dsh-b'));
  assert.equal(await effectiveProjectRoot(m7Loop), m7Loop, 'm7：.dsh 是循环链接时也按"有声明"处理');
  // 兜底：项目目录本身不可读 → 归属根算不出来也要保留这一行（degraded）。
  const m7Dark = join(tempHome, 'm7', 'dark');
  await mkdir(join(m7Dark, '.git'), { recursive: true });
  await chmod(m7Dark, 0o000);
  try {
    const darkRows = await listManageableWorkspaces({ workspaces: [{ id: 'id-dark', path: m7Dark, title: 'Dark' }] });
    assert.equal(darkRows.length, 1, 'm7：归属根算不出来也不能丢行');
    assert.equal(darkRows[0].path, m7Dark);
    assert.equal(darkRows[0].degraded, true, 'm7：根降级要标注 degraded');
  } finally {
    await chmod(m7Dark, 0o755);
  }
  console.log('PASS 2g/5 m7：.dsh EACCES/ELOOP 保守按有声明处理；根算不出来时保留该行并标 degraded');

  // ---- m8：`~/.dsh` 是 symlink 时容器集合必须用 realpath
  const home2 = await realpath(await mkdtemp(join(tmpdir(), 'pm-hub-home2-')));
  const dshReal2 = join(home2, 'dsh-real');
  try {
    await mkdir(dshReal2, { recursive: true });
    await writeFile(join(dshReal2, 'package.json'), '{"name":"real-dsh-home"}\n', 'utf8');
    await mkdir(join(dshReal2, 'x'), { recursive: true });
    await symlink(dshReal2, join(home2, '.dsh'));
    process.env.HOME = home2;
    delete process.env.DSH_HOME;
    assert.equal(homedir(), home2);
    assert.equal(await effectiveProjectRoot(join(home2, '.dsh')), dshReal2, 'm8：~/.dsh symlink 应解析成 target');
    assert.equal(
      await effectiveProjectRoot(join(dshReal2, 'x')),
      join(dshReal2, 'x'),
      'm8：target 里的子目录不解析到 target（容器的 package.json 不算 marker）',
    );
  } finally {
    process.env.HOME = tempHome;
    process.env.DSH_HOME = tempDsh;
    await rm(home2, { recursive: true, force: true });
  }
  console.log('PASS 2h/5 m8：~/.dsh symlink 解析成 target，target 内的子目录仍归属自己');

  // ---- m9：`.dsh` 是普通文件 → effective 不认（ENOTDIR），legacy 认
  const fileDshParent = join(tempHome, 'm9', 'parent');
  const fileDshChild = join(fileDshParent, 'child');
  await mkdir(fileDshChild, { recursive: true });
  await writeFile(join(fileDshParent, '.dsh'), 'not a directory\n', 'utf8');
  assert.equal(await effectiveProjectRoot(fileDshChild), fileDshChild, 'm9：.dsh 是普通文件时不算声明 → 子目录归属自己');
  assert.equal(await resolveProjectRoot(fileDshChild), fileDshParent, 'm9：legacy 仍把 .dsh 文件当 marker（语义不变）');
  console.log('PASS 2i/5 m9：.dsh 是普通文件时 effective=child、legacy=父（预期差异，README 已写明）');

  // ---- m7-API：单行不可读不能让 `/workspaces` 整批 400（面板一行不剩）
  const apiNormal = join(tempHome, 'api', 'normal');
  const apiLocked = join(tempHome, 'api', 'locked'); // `.dsh` chmod 000
  const apiDark = join(tempHome, 'api', 'dark'); // 项目目录 chmod 000
  await mkdir(apiNormal, { recursive: true });
  await mkdir(join(apiLocked, '.dsh'), { recursive: true });
  await writeFile(join(apiLocked, '.dsh', 'profile.yml'), 'name: api-locked\n', 'utf8');
  await mkdir(join(apiDark, '.git'), { recursive: true });
  const apiRegistry = [
    { id: 'id-api-normal', path: apiNormal, title: 'ApiNormal' },
    { id: 'id-api-locked', path: apiLocked, title: 'ApiLocked' },
    { id: 'id-api-dark', path: apiDark, title: 'ApiDark' },
  ];
  await chmod(join(apiLocked, '.dsh'), 0o000);
  await chmod(apiDark, 0o000);
  try {
    let apiOrigin;
    const apiRoute = createMemoryRoute({ workspaces: () => apiRegistry, origin: () => apiOrigin, invalidate: () => {} });
    const apiServer = createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === apiRoute.path || pathname.startsWith(`${apiRoute.path}/`)) return apiRoute.handler(req, res);
      res.writeHead(404); res.end('unmatched host route');
    });
    await new Promise((done) => apiServer.listen(0, '127.0.0.1', done));
    apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;
    try {
      // 1) 列表：必须 200，三行都在，不可读行降级为 enabled=true
      const listResponse = await fetch(`${apiOrigin}/api/project-memory/workspaces`);
      assert.equal(listResponse.status, 200, 'GET /workspaces 必须 200：单行不可读不得整批 400');
      const payload = await listResponse.json();
      assert.ok(Array.isArray(payload.projects));
      assert.deepEqual(
        payload.projects.map((row) => row.path).sort(),
        [apiDark, apiLocked, apiNormal].sort(),
        '不可读行必须保留（否则面板会整片消失）',
      );
      for (const row of payload.projects) {
        assert.deepEqual(Object.keys(row).sort(), ['enabled', 'id', 'path', 'title'], 'API 行字段不变');
        assert.equal(row.enabled, true, '开关读不到时降级为启用');
      }
      // 2) 详情：选中不可读行也必须 200 + 空 entries（文件路径仍给出）
      for (const id of ['id-api-dark', 'id-api-locked', 'id-api-normal']) {
        const detailResponse = await fetch(`${apiOrigin}/api/project-memory/memory?id=${encodeURIComponent(id)}`);
        assert.equal(detailResponse.status, 200, `GET /memory?id=${id} 不能 400`);
        const detail = await detailResponse.json();
        assert.deepEqual(detail.entries, []);
        assert.equal(detail.enabled, true);
        assert.equal(typeof detail.file, 'string', '仍然给出记忆文件路径，便于定位权限问题');
      }
      // 3) overview：不抛、不丢行，dark 行标 degraded
      const apiOverview = await overview({ workspacePaths: apiRegistry });
      assert.equal(apiOverview.total, 3, 'overview 不得因单行不可读丢行');
      const darkRow = apiOverview.projects.find((row) => row.path === apiDark);
      assert.equal(darkRow.exists, false);
      assert.equal(darkRow.entries, 0);
      assert.deepEqual(darkRow.files, []);
      assert.equal(darkRow.degraded, true, 'overview 行标 degraded（内部字段）');
      const normalRow = apiOverview.projects.find((row) => row.path === apiNormal);
      assert.equal(normalRow.degraded, false);
      // 4) 安全校验没被削弱
      const crossOrigin = await fetch(`${apiOrigin}/api/project-memory/workspaces`, { headers: { origin: 'https://evil.example' } });
      assert.equal(crossOrigin.status, 403, 'origin 校验不得削弱');
      const crossSite = await fetch(`${apiOrigin}/api/project-memory/workspaces`, { headers: { 'sec-fetch-site': 'cross-site' } });
      assert.equal(crossSite.status, 403, 'cross-site 校验不得削弱');
      const badId = await fetch(`${apiOrigin}/api/project-memory/memory?id=not-registered`);
      assert.equal(badId.status, 403, '未注册 id 仍然 403');
      // 容错不得吃掉 symlink 校验：把正常行的 canonical 文件换成 symlink → /memory 仍 400
      const normalPaths = await resolveMemoryPaths(apiNormal);
      await mkdir(normalPaths.dir, { recursive: true });
      const outsideSecret = join(tempHome, 'api', 'secret.md');
      await writeFile(outsideSecret, 'secret\n', 'utf8');
      await symlink(outsideSecret, normalPaths.file);
      assert.equal(
        (await fetch(`${apiOrigin}/api/project-memory/memory?id=id-api-normal`)).status,
        400,
        'symlink 拒绝不能被"降级"吃掉：仍然 400',
      );
    } finally {
      await new Promise((done) => apiServer.close(done));
    }
  } finally {
    await chmod(join(apiLocked, '.dsh'), 0o755);
    await chmod(apiDark, 0o755);
  }
  console.log('PASS 2j/5 m7-API：dark/locked 行存在时 GET /workspaces 200（3 行、enabled 降级 true）、/memory 200 空 entries、overview 不丢行，origin/cross-site/未注册 id 仍 403');

  // ------------------------------ 4. overview() 与 web API 对同一注册表行集合一致
  const route = createMemoryRoute({
    workspaces: () => registry,
    origin: () => origin,
    invalidate: () => {},
  });
  assert.equal(route.path, '/api/project-memory');
  server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === route.path || pathname.startsWith(`${route.path}/`)) return route.handler(req, res);
    res.writeHead(404); res.end('unmatched host route');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;

  const api = await (await fetch(`${origin}/api/project-memory/workspaces`)).json();
  assert.deepEqual(
    api.projects.map((row) => Object.keys(row).sort()),
    api.projects.map(() => ['enabled', 'id', 'path', 'title']),
    'API 行字段必须保持 { id, path, title, enabled }',
  );
  const apiPaths = api.projects.map((row) => row.path).sort();
  assert.deepEqual(apiPaths, [...byRoot.keys()].sort(), 'API 行 path 必须与枚举函数一致');

  const summary = await overview({ workspacePaths: registry });
  assert.deepEqual(
    summary.projects.map((row) => row.path).sort(),
    apiPaths,
    'overview() 与 web API 必须返回同一批 path',
  );
  assert.equal(summary.total, api.projects.length, 'overview().total 必须等于 API 行数');
  for (const row of summary.projects) {
    assert.equal(row.entries, 0, '夹具项目不应有任何记忆条目');
    assert.equal(row.exists, false, '夹具项目不应有记忆文件');
    assert.equal(row.file.endsWith('.md'), true);
    assert.equal(row.dir, join(row.path, '.dsh', 'memory'));
  }
  // 折叠掉的工作区 ID 不再接受面板操作（它们没有自己的记忆文件）。
  assert.equal((await fetch(`${origin}/api/project-memory/memory?id=id-child`)).status, 403);
  assert.equal((await fetch(`${origin}/api/project-memory/memory?id=id-parent`)).status, 200);
  console.log(`PASS 3/5 overview() 与 web API 同口径：${summary.total} 行，path 集合完全一致，字段 {id,path,title,enabled} 不变`);

  // 枚举全程只读：夹具里不该长出 .dsh/memory。
  for (const dir of [parent, plain, withPkg, pkgOnly, tempHome]) {
    assert.equal(await snapshot(join(dir, '.dsh', 'memory')), '(missing)', `枚举不得创建 ${pretty(dir)}/.dsh/memory`);
  }
  console.log('PASS 4/5 枚举只读：夹具内未创建任何 .dsh/memory 目录');

  // ---------------- 5. 真实注册表只读跑一次（软断言：换机器或空注册表不误报）
  process.env.HOME = realHomeEnv;
  if (realDshHomeEnv === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = realDshHomeEnv;
  assert.equal(dshHome(), realDshHome, 'HOME/DSH_HOME 必须已恢复真实值');
  await new Promise((done) => server.close(done));
  server = undefined;

  const registryFile = workspaceRegistryPath();
  const beforeRegistry = await fingerprint(registryFile);
  const beforeMemory = await snapshot(join(realDshHome, 'memory'));
  const beforeSettings = await snapshot(join(realDshHome, 'storages'));

  const registeredRows = await listRegisteredWorkspaces();
  if (registeredRows.length === 0) {
    // 首次运行 / 新机器 / 注册表缺失：夹具断言已覆盖语义，这里只 skip 并打印原因。
    console.log(`SKIP 5/5 真实注册表为空或不可读（${pretty(registryFile)}），跳过软断言`);
  } else {
    const real = await overview({});
    const realManageable = await listManageableWorkspaces({ workspaces: registeredRows });
    assert.ok(real.total >= 1, `真实注册表有 ${registeredRows.length} 项，却只列出 ${real.total} 行`);
    assert.equal(real.total, realManageable.length, 'overview 与枚举函数行数必须一致');
    assert.deepEqual(
      real.projects.map((row) => row.path).sort(),
      realManageable.map((row) => row.path).sort(),
      '真实注册表下 overview 与枚举函数 path 集合必须一致',
    );

    // B1 回归的硬事实：解析根是自己的注册工作区必须有自己的一行（父级自造 .dsh
    // 不得把它们折叠掉）。真实风险组合：~/Downloads→sda/dfda、~/AGI/123123→ddd/213123 …
    const selfRooted = [];
    for (const row of registeredRows) {
      try {
        const absolute = await realpath(row.path);
        if (await effectiveProjectRoot(absolute) === absolute) selfRooted.push(absolute);
      } catch { /* 消失的注册路径不参与 */ }
    }
    const missing = selfRooted.filter((path) => !real.projects.some((row) => row.path === path));
    assert.deepEqual(missing.map(pretty), [], '解析根是自己的注册工作区不得被折叠（B1 回归）');

    // 同一注册表的真实 route：path 集合必须与 overview 一致。
    let realOrigin;
    const realRoute = createMemoryRoute({ workspaces: () => registeredRows, origin: () => realOrigin });
    server = createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === realRoute.path || pathname.startsWith(`${realRoute.path}/`)) return realRoute.handler(req, res);
      res.writeHead(404); res.end('unmatched host route');
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    realOrigin = `http://127.0.0.1:${server.address().port}`;
    const realApi = await (await fetch(`${realOrigin}/api/project-memory/workspaces`)).json();
    assert.deepEqual(
      realApi.projects.map((row) => row.path).sort(),
      real.projects.map((row) => row.path).sort(),
      '真实注册表下 API 与 overview 的 path 集合必须一致',
    );
    await new Promise((done) => server.close(done));
    server = undefined;

    // m1：空数组就是空注册表，不能回退磁盘注册表（真实注册表非空才有区分度）。
    const emptyOverview = await overview({ workspacePaths: [] });
    assert.equal(emptyOverview.total, 0, 'overview({ workspacePaths: [] }) 必须返回 0 行，不能回退磁盘注册表');

    for (const row of real.projects) {
      const name = row.title.padEnd(10);
      console.log(`    ${name} ${pretty(row.path).padEnd(44)} entries=${row.entries} exists=${row.exists}`);
    }
    // hackerking 若在本机注册表里：overview 的 entries 必须与 store 实读一致；否则 skip。
    const hackerkingRow = real.projects.find((row) => basename(row.path) === 'hackerking');
    if (hackerkingRow === undefined) {
      console.log('  SKIP hackerking 行：本机注册表里没有 hackerking 工作区');
    } else {
      const hackerkingState = await readProjectMemory(hackerkingRow.path, {});
      assert.equal(hackerkingRow.entries, hackerkingState.entries.length, 'hackerking 行 entries 必须与 store 实读一致');
      assert.equal(await effectiveProjectRoot(hackerkingRow.path), hackerkingRow.path, 'hackerking 必须 self-rooted');
      // `.dsh` 的声明断言只在它真的存在且可读时做；不存在/不可读就 SKIP 这个子断言
      // （换台机器 hackerking 可能只靠 `.git` 当 marker，不该因此失败）。
      let dshEntries = null;
      try {
        dshEntries = await readdir(join(hackerkingRow.path, '.dsh'));
      } catch { dshEntries = null; }
      if (dshEntries === null) {
        console.log('  SKIP hackerking .dsh 子断言：`.dsh` 不存在或不可读，marker 来自 `.git`/`package.json`');
      } else {
        const declarations = dshEntries.filter((name) => name !== 'memory' && name !== '.DS_Store');
        if (declarations.length === 0) {
          console.log(`  SKIP hackerking .dsh 子断言：只有 ${JSON.stringify(dshEntries)}，marker 来自 \`.git\`/package.json`);
        } else {
          console.log(`  hackerking .dsh 声明项: ${declarations.join(', ')}（.dsh 因此仍是 marker）`);
        }
      }
      console.log(`  hackerking: ${pretty(hackerkingRow.path)} entries=${hackerkingRow.entries}（与 store 实读一致）`);
    }
    console.log(`PASS 5/5 真实注册表：注册 ${registeredRows.length} 项 → ${real.total} 行；self-rooted ${selfRooted.length} 个都有行；overview / 枚举 / API path 集合一致`);
  }

  // 只读证明：注册表字节一致，~/.dsh 记忆与 storages 目录快照一致。
  assert.equal(await fingerprint(registryFile), beforeRegistry, '真实注册表必须未被修改');
  assert.equal(await snapshot(join(realDshHome, 'memory')), beforeMemory, '~/.dsh/memory 必须未被写入');
  assert.equal(await snapshot(join(realDshHome, 'storages')), beforeSettings, '~/.dsh/storages 必须未被写入');
  console.log(`PASS 真实数据只读：${pretty(registryFile)} 字节未变 · ~/.dsh/memory 与 storages 目录快照未变`);

  console.log('OK hub-regression: 归属根、折叠、去重、B1 开关自造 marker、m4 隔离、API/overview 同口径全部通过');
} finally {
  if (server !== undefined) await new Promise((done) => server.close(done));
  if (realDshHomeEnv === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = realDshHomeEnv;
  process.env.HOME = realHomeEnv;
  for (const dir of fixtures) await rm(dir, { recursive: true, force: true }).catch(() => {});
}
