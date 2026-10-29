---
name: ghidra-bridge
description: 需要把 Ghidra 接入 DSH 做反编译/逆向分析时使用：安装 Ghidra 与 GhidraMCP、无头批量分析、MCP 接线与排障。Ghidra 本体是桌面应用，本插件不含 Ghidra，只提供接入链路。
---

# Ghidra 接入桥（DSH）

Ghidra 是 NSA 开源的逆向工程套件（Java 桌面应用），不是插件能安装的形态。本插件提供“让 DSH 驱动 Ghidra”的完整链路：装 Ghidra → 装 GhidraMCP → 接 MCP → 无头分析。

方法论与工作流（怎么拆样本、怎么比对、怎么出报告）看 `reverse-skills` 的 `ghidra-reverse` 技能；本技能只管“装得上、连得通”。

## 1. 安装 Ghidra

```bash
# macOS
brew install --cask ghidra
# 或官网下载 zip 解压：https://ghidra-sre.org
```

验证：

```bash
ls /Applications/ghidra*/ghidraRun 2>/dev/null || ls ~/ghidra*/ghidraRun 2>/dev/null
```

无头入口通常是 `<Ghidra>/support/analyzeHeadless`。

## 2. 安装 GhidraMCP

上游：[LaurieWired/GhidraMCP](https://github.com/LaurieWired/GhidraMCP)（MIT）。需要 200+ 工具与 headless server 模式时，可改用 [bethington/ghidra-mcp](https://github.com/bethington/ghidra-mcp)。

1. 下载上游最新 Release 的 zip（Ghidra 插件 + Python MCP 桥）。
2. Ghidra → `File` → `Install Extensions` → `+` → 选 zip → 重启 Ghidra。
3. 打开 CodeBrowser → `File` → `Configure` → 勾选 `GhidraMCPPlugin`。
4. 确认本地接口：`curl -s http://127.0.0.1:8080/methods?limit=5` 返回 JSON。

## 3. 接线到 DSH（MCP）

在本插件目录执行：

```bash
bash <插件>/scripts/setup.sh
# 或直接写进 profile：
bash <插件>/scripts/setup.sh --profile desktop
```

脚本做三件事：

```text
python3 -m venv <插件>/.venv
<插件>/.venv/bin/pip install mcp
curl -L -o <插件>/bridge_mcp_ghidra.py https://raw.githubusercontent.com/LaurieWired/GhidraMCP/main/bridge_mcp_ghidra.py
```

然后生成 `ghidra-mcp.patch.yml`：

```yaml
- insert:
    - id: mcp-ghidra
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ghidra
        transport: stdio
        command: <插件>/.venv/bin/python
        args: [<插件>/bridge_mcp_ghidra.py, '--ghidra-server', 'http://127.0.0.1:8080/']
        toolCallTimeoutMs: 120000
        failOnStartupError: false
```

把这段合并进 profile 的 `cordis.patch.yml`，或让 `setup.sh --profile <name>` 追加。重启 DSH 后工具以 `mcp__ghidra__*` 出现。

**前提永远是第 2 步的 Ghidra 正在运行且插件已勾选**——MCP 桥只转发到 8080。

## 4. 无头批量分析（不开 GUI）

```bash
<Ghidra>/support/analyzeHeadless /tmp/ghidra-projects proj \
  -import /path/to/sample \
  -postScript <脚本> \
  -deleteProject
```

适合 CI 或批量反编译；脚本用 Java 或 PyGhidra 写。产物（反编译文本、函数清单、字符串）再交给 DSH 解读。

批量最小流水线：

```bash
mkdir -p /tmp/ghidra-out
<Ghidra>/support/analyzeHeadless /tmp/ghidra-projects proj \
  -import <SAMPLE> \
  -postScript DumpFunctions.java \
  -scriptPath <脚本目录> \
  -deleteProject 2>&1 | tee /tmp/ghidra-out/run.log
```

## 5. 验收冒烟

1. `curl -s http://127.0.0.1:8080/methods?limit=5` 有 JSON → GhidraMCP 通了。
2. DSH 里新开会话，问“列出当前样本的前 5 个函数” → 返回真实函数名 → 链路全通。
3. 不通时按顺序排查：Ghidra 没开 > 插件没勾选 > 8080 被占 > venv 没建 > profile patch 没合并 > 没重启。

## 6. DSH 工具映射

| 动作 | 工具 |
|---|---|
| 列出函数/方法 | `mcp__ghidra__list_methods`（名称以上游实际注册为准） |
| 反编译函数 | `mcp__ghidra__decompile_function` |
| 重命名 | `mcp__ghidra__rename_function` / `rename_variable` |
| 交叉引用 | `mcp__ghidra__get_xrefs` |
| 字符串 | `mcp__ghidra__list_strings` |

工具名以 MCP 实际注册为准；先 `list_agents` 之外的 MCP 工具目录，或在会话里让模型列一次。

## 7. 边界

- 不下载 Ghidra 本体；Ghidra 为 Apache-2.0。
- 不预置 MCP 连接：没装 GhidraMCP 时连接必然失败，所以 `.mcp.json` / patch 由 setup 脚本按需生成。
- 不自动勾选 Ghidra 插件、不自动启动 GUI；这些需要用户在本机操作。
- GhidraMCP 为 MIT；桥接脚本与配置模板为本插件自写（MIT）。

## 验收清单

- [ ] Ghidra 可启动，`analyzeHeadless` 路径已记录
- [ ] GhidraMCP 扩展已安装并勾选
- [ ] `curl 127.0.0.1:8080/methods?limit=5` 有响应
- [ ] `mcp__ghidra__*` 工具出现在 DSH 会话
- [ ] 一次真实函数反编译成功，输出已落 `cases/<case>/evidence/`
