---
name: crack-router
description: 破解工作台总控。样本刚进来、不确定先补丁还是先还原算法、或需要在接单/补丁/注册机/APK/脱壳/报告之间切换时先加载本技能，按目标形态与授权判定位置选路线。
---

# Crack Lab Router

本包只做一件事：把破解项目拆成可验收的阶段，并选对下一位技能。所有产物落在 `cases/<case>/`，插件目录只读。

## 适用

- 样本刚进工作台，还没有任何结论。
- 已跑通一半，不确定下一步是补丁、keygen、脱壳还是补证据。
- 需要给用户一个可复现的破解方案，而不是一堆零散命令。

不适用：纯 Web 渗透、纯 CTF 杂项、纯恶意样本行为分析。这些走 `reverse-skills` 的对应模块。

## 先做三个判断

### 1. 目标形态

| 形态 | 首要技能 |
|---|---|
| macOS `.app` / Mach-O / dmg | `crack-intake` → `license-patch` 或 `native-unpack` |
| Windows PE / .NET | `crack-intake` → `license-patch` |
| Android APK / XAPK / split | `apk-crack` |
| iOS IPA | `crack-intake` → `native-unpack` |
| Electron / `app.asar` / JS | `crack-intake` → `license-patch`（JS 补丁）或 `keygen-model` |
| 固件 / 嵌入式 | `crack-intake` → `native-unpack` |
| 加密狗 / license server 客户端 | `crack-intake` → `keygen-model` 或服务端模拟 |

### 2. 授权判定在哪里

- **本地布尔/试用天数/功能位** → `license-patch`。
- **本地算法可离线验证**（序列号、激活码、机器码）→ `keygen-model`。
- **服务端回包判定** → 先协议还原（`reverse-skills` 的 `protocol-reverse`），再决定模拟、补丁或放弃本地路线。
- **非对称签名 + 私钥不在客户端** → keygen 不可行，转补丁或服务端模拟。

### 3. 有没有保护

- 加壳 / 混淆 / 反调试 / 字符串加密 → 先 `native-unpack`。
- APK 整体加固 → 先 `apk-crack` 的加固分支，再进 `native-unpack` 处理 so。
- 只有签名校验 / 证书固定 → 不需要脱壳，直接 `license-patch` / `apk-crack`。

## 标准流水线

```text
0 接单建档    crack-intake   → cases/<case>/scope.md + sample hash + 工具预检
1 指纹/保护   crack-intake   → 壳、混淆、反调试、签名、网络依赖
2 静态定位    license-patch / apk-crack / native-unpack
3 动态验证    native-unpack（hook/dump）或 apk-crack（Frida）
4 破解实现    补丁字节 / keygen / 重打包 / 服务端模拟
5 验证矩阵    原版失败 + 破解成功 + 负例 + 重启后仍成立
6 报告交付    crack-report  → report.md + patches/ + evidence/
```

每个阶段结束都要能回答：输入是什么、命令是什么、输出是什么、下一步是谁。

## 工作区命令

```bash
bash ~/Documents/hackerking/scripts/preflight.sh
bash ~/Documents/hackerking/scripts/new-case.sh <case> <样本路径>
```

`new-case.sh` 会创建：

```text
cases/<case>/
├── scope.md
├── sample/
├── notes/
├── evidence/
├── patches/
└── report.md
```

## 失败分支

- **工具缺失**：先列缺失清单与安装命令，不要跳过阶段硬做。
- **静态读不出**：转动态 hook 或内存 dump；仍读不出再评估壳/VM 保护成本。
- **补丁后崩溃**：先校验 patch 偏移与指令长度，再检查代码签名/完整性校验。
- **补丁后功能正常但重启失效**：找持久化校验点（启动项、缓存、服务端心跳）。
- **keygen 生成被拒**：检查字符集、校验位、时间戳、机器码绑定与大小端。
- **服务端判定**：本地补丁只能改表现，不能改判定；转协议还原或明确交付边界。

## 验收清单

- [ ] `cases/<case>/scope.md` 已落盘，目标与范围写清
- [ ] 样本 sha256、文件类型、架构、依赖已记录
- [ ] 保护指纹与判定位置已确认（不是猜）
- [ ] 破解路径至少有一条可复现命令链
- [ ] 原版/破解版/负例三组验证通过
- [ ] `patches/` 有原始备份与回滚脚本
- [ ] `report.md` 的证据编号能对上 `evidence/`
