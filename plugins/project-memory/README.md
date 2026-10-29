# project-memory

**项目级持久记忆**：ZCode `~/.zcode/cli/memories/projects/<name>-<hash>/` 的 DSH 等价物。

每个项目一份 Markdown，按**项目绝对路径的哈希**命名并隔离：

```text
<project>/.dsh/memory/<basename>-<sha256(abs path)[:16]>.md
/Users/zhangsugang/Documents/hackerking/.dsh/memory/hackerking-830378652aff00d8.md
```

- 项目 A 写的条目，项目 B 的会话**读不到**（文件不同、slug 不同、技能内容不同）。
- 记忆是项目文件，可以跟着仓库走、可以 diff、可以 code review；不需要向量库。

## 交付面

| 面 | 名称 | 说明 |
|---|---|---|
| 技能 | `project-memory` | 每次加载都用当前项目记忆重建正文（不是缓存快照） |
| 工具 | `memory_write` | 追加一条：`text` + 可选 `title` / `source` |
| 工具 | `memory_read` | 读本项目全部记忆，可按 `section` 过滤 |
| 工具 | `memory_status` | 项目根、slug、文件、条目数、字节数、目录内文件 |

## 安装

方式一（patch 层，热生效，不改 bundle 列表）：

```bash
node scripts/install-project-memory.mjs --dry-run
node scripts/install-project-memory.mjs --apply
```

它往 `~/.dsh/profiles/desktop/cordis.patch.yml` 插入：

```yaml
- insert:
    - id: project-memory
      name: /Users/zhangsugang/Documents/hackerking/plugins/project-memory/lib/index.js
      config:
        memoryRoot: .dsh/memory
```

`patchReload: live` 的 profile 立即生效；其他 profile 重启后生效。移除：`--remove --apply`。

方式二（作为 bundle 安装，需要重启）：

```bash
dsh plugin --profile desktop add link:~/Documents/hackerking/plugins/project-memory
```

`package.json` 已声明 `dsh.bundle.patch`，装进 profile 后会自动插入同一个条目。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `memoryRoot` | `.dsh/memory` | 项目内相对目录，或绝对目录（仍按 slug 隔离） |
| `maxInjectBytes` | `32768` | 技能正文最多注入多少字节记忆 |
| `skillName` | `project-memory` | 技能名 |
| `providerName` | `project-memory` | skill provider 名（`runtime` 保留） |
| `toolPrefix` | `memory` | 工具前缀：`memory_write` / `memory_read` / `memory_status` |
| `enableTools` | `true` | 只要技能、不要工具时设 `false` |

## 原生设置 → 记忆

插件 client 通过宿主 `settings.section` 注册「记忆」入口；Host 通过 `webServer.register` 提供同源 API，不启动独立端口。`lib/*.js`（Host 侧）由宿主 HMR 监听、改完即热生效（实测同一 DSH 进程内 API 由 2 行变 17 行）；只有 `package.json` / `dsh.client` 等元数据变更才需要重启 DSH。`client.js` 没有构建步骤，改完刷新页面即可。

- 一行一个**记忆归属根**（`effectiveProjectRoot`），不是注册路径；同一根只留一行，symlink 拼写不会重复。
- `.dsh` 只有包含**项目声明**（`profile.yml` / `profile.patch.yml` / `skills` / `plugins.yml` 等；`memory` 与 `.DS_Store` 不算）才当 marker，所以给父目录切开关/写记忆自造的 `<父>/.dsh/memory` 不会把已注册的子工作区折叠掉。
- 嵌套工作区只在解析根是**另一个注册工作区**时折叠为父级（父级 ID/标题取胜），否则保留自己的行。
- API 的 `/workspaces` 与 `hub.overview()` 共用 `hub.listManageableWorkspaces()`，两处行集合永远一致。
- 工作区选择、标题/内容搜索、条目展开查看；停用后仍可人工查看已有内容。
- 每项目开关存于记忆目录内 `<slug>.settings.json`，默认启用，不迁移或覆盖 Markdown。
- 停用即时阻止三个工具与技能 get/list；设置写入触发技能目录失效。
- API 按工作区 ID 查实时注册表，不接收任意路径；严格 Host/Origin、POST CSRF token、JSON 类型和体积校验。文件及父目录 symlink 被阻止。
- 同进程同项目的追加和开关按文件键串行化，避免并发首次写入丢条目。
- `scripts/memory-ui.mjs`（**仓库根 338B stub，不在插件包内**）仅提示原生入口，旧独立 HTTP 服务已撤下。

## 自测

```bash
node plugins/project-memory/scripts/selftest.mjs
node plugins/project-memory/scripts/settings-selftest.mjs
node plugins/project-memory/scripts/client-selftest.mjs
node plugins/project-memory/scripts/hub-regression.mjs   # 归属根 / 折叠 / API 同口径 / 真实注册表只读
```

覆盖：provider 列表/加载、三个工具的写读状态、A/B 项目隔离、共享绝对 `memoryRoot` 下仍按 slug 隔离、设置开关与 CSRF、client 状态机，以及记忆归属根（家目录不再抢占子目录、HOME 自身仍是项目、真嵌套折叠、`overview()` 与 API 同口径、`.dsh` 自造目录不折叠子行、折叠根可读可写、shared memoryRoot 不跨项目读且 `exists` 只认 canonical、`.dsh` 读不到/循环链接不丢行、`~/.dsh` symlink 解析成 target、`.dsh` 普通文件与 legacy 的预期差异）。真实注册表段是**软断言**：注册表存在时校验 overview / 枚举 / API 的 path 集合一致与 self-rooted 行不丢，缺失时打印 SKIP 而不是失败。

## 设计说明

- **注入路径**：走 skill provider，不改宿主提示词、不改全局 AGENTS.md。技能目录项稳定（一个 `project-memory`），正文每次 `get()` 重新读盘，因此同一会话里新写的记忆也能立刻被读到。
- **根目录判定（`resolveProjectRoot`）**：向上找 `.git` → `.dsh` → `package.json`，找不到就用起点。**语义冻结**：仍导出，作为"纯 marker"参照（`scripts/hub-regression.mjs` 用它证明家目录抢占的旧行为），但写入、读取、技能与面板都不再走它。
- **记忆归属根（`effectiveProjectRoot`）**：同样的 marker 逻辑，但有两处收紧：① `$HOME` 与 `$DSH_HOME`（默认 `$HOME/.dsh`，**含 symlink 解析**）作为**祖先**时，它们自己的 `.dsh` / `package.json` / `.git` 不算项目标记——否则家目录会把所有没有 marker 的工作区抢占成一个项目；② `.dsh` 只有在包含项目声明时才算标记（`memory` / `.DS_Store` 除外），所以父目录切开关或写记忆自造的 `<父>/.dsh/memory` 不会把子工作区折叠掉。`.dsh` 是**普通文件**时不算声明（`ENOTDIR`），legacy 的 `pathExists` 仍会认它——这是预期差异；`.dsh` 读不到（`EACCES` / `EPERM` / `ELOOP`）时保守按"有声明"处理，权限或循环链接不会让异常杀死整行。起点自身就是 HOME / DSH_HOME 时仍返回自身。`memory_write` / `memory_read` / `memory_status`、技能 provider、`hub.overview()` / `/workspaces` 与 `scripts/project-memory.mjs`（含 `--project`）全部用它，所以"看得见的行"和"写进去的文件"永远同根。
- **写入**：只追加，不重写历史；每条带 ISO 时间戳与可选 `source` 证据标记。
- **不做**：向量检索、跨项目召回、自动摘要。DSH 的技能/工具面已经够用，语义检索等有需求再加。

## 已知限制

- 外部进程直接修改开关文件时，技能目录缓存可能延迟；get 与三个工具每次检查开关。原生设置写入会主动触发目录失效。
- 路径检查防止已有 symlink 越界；不承诺抵抗同一用户恶意进程在检查后瞬间替换父目录的竞态。
- 记忆文件默认落在项目里，是否入库由项目的 `.gitignore` 决定；不想入库就加 `.dsh/memory/`。
- **历史数据可能已错位**：修复前从无 marker 的工作区写的记忆落在 `$HOME/.dsh/memory/<home-slug>.md`，修复后它不再属于任何面板行（HOME 不在注册表）。按条目里的路径/`source` 判断归属，用显式项目根重新写入目标项目后把旧文件改名留档；插件不自动迁移。
- **`<父>/.dsh/memory` 不再改变面板行**（review B1，已修）：旧判定把"存在 `.dsh`"当 marker，于是给父工作区切一次开关或写一条记忆（插件会在 `<父>/.dsh/memory/` 建 `<slug>.settings.json` / `<slug>.md`）就会让它升级为 marker，已注册的子工作区被折叠、整行消失（真实组合：`~/Downloads`→sda/dfda、`~/AGI/123123`→ddd/213123、`~/AGI/123123/ddd`→213123、`~/AGI/code`→服务器）。现在 `.dsh` 只有在包含项目声明（`profile.yml` / `profile.patch.yml` / `skills` / `plugins.yml` 等，`memory` 与 `.DS_Store` 除外）时才算 marker，父级开关/写入不再影响行集合；像 `hackerking` 这种带 profile/skills 的 `.dsh` 仍是 marker。`resolveProjectRoot` 保持 legacy 纯 `pathExists` 语义不变（仅作对照，不参与写入/面板）。
- **枚举层与 API 层都不因单行失败丢行 / 整批失败**（review m7 / m7-API）：归属根算不出来（项目目录不可读等）时该行仍保留，`path` 退回自身并带 `degraded: true`（仅内部标注，不进 API 行字段）；只有路径本身已不可解析（被删 / 断链）才跳过。`GET /workspaces` 的 `enabled` 读失败降级为 `true`，`GET /memory` 的开关与正文各自降级（空 entries + enabled true，记忆文件路径照样给出，便于定位权限问题），`overview()` 的 `listMemoryFiles` / `readProjectMemory` 失败按"无记忆"处理（files=[]、entries=0、exists=false），行保留——单行权限问题不会让面板整片消失。`overview()` 的 `exists` 只认本项目 canonical `<slug>.md`，shared 绝对 `memoryRoot` 下不会把别的项目文件算成自己存在，`withMemory` 因此准确。
- 插件不主动判断“记忆是否过期”；与现场证据冲突时以现场为准并追加纠正条目。
