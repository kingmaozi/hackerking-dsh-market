# ghidra-bridge

把 **Ghidra + GhidraMCP** 接进 DeepSeek Harness。技能负责“怎么装、怎么连、怎么排障”，`scripts/setup.sh` 负责一次性建好 venv、拉官方桥接脚本、生成 DSH MCP patch。

双击式安装不存在：Ghidra 是桌面应用，GhidraMCP 是 Ghidra 扩展，两步都要在本机手动完成；本插件只把链路铺好。

## 安装技能

```bash
bash ~/Documents/hackerking/scripts/install-local.sh --profile desktop
```

## 接线 MCP

```bash
bash ~/Documents/hackerking/plugins/ghidra-bridge/scripts/setup.sh
# 或直接写进 profile（会先备份 cordis.patch.yml）
bash ~/Documents/hackerking/plugins/ghidra-bridge/scripts/setup.sh --profile desktop
```

生成的 `ghidra-mcp.patch.yml`：

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

重启 DSH 后，工具以 `mcp__ghidra__*` 出现。

## 前提

1. `brew install --cask ghidra`（或官网 zip）。
2. 安装 [LaurieWired/GhidraMCP](https://github.com/LaurieWired/GhidraMCP) 扩展并在 CodeBrowser 里勾选。
3. `curl -s http://127.0.0.1:8080/methods?limit=5` 有 JSON。

## 用法

```text
skill: ghidra-bridge
帮我装好 GhidraMCP 并接到 DSH，然后反编译这个样本的 main。
```

无头批量：

```bash
<Ghidra>/support/analyzeHeadless /tmp/ghidra-projects proj -import <SAMPLE> -postScript <脚本> -deleteProject
```

## 边界

不下载 Ghidra 本体，不自动启动 GUI，不自动勾选扩展；Ghidra 为 Apache-2.0，GhidraMCP 为 MIT。
