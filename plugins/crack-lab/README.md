# crack-lab

破解工作台的 DSH 原生技能包：从一个样本进来到一份可复现报告，七个技能覆盖全流程。

| 技能 | 用途 |
|---|---|
| `crack-router` | 总控：按目标形态、授权判定位置、保护强度选路线 |
| `crack-intake` | 接单建档：类型判定、sha256、保护指纹、工具预检、scope.md |
| `license-patch` | 定位 CHECK_FN，记录 OFFSET/PATCH_BYTE，字节补丁 + 重签名 + 验证矩阵 |
| `keygen-model` | 序列号/激活码算法还原，z3 约束求解，Python/C keygen 骨架 |
| `apk-crack` | jadx/apktool/Frida/objection，smali 补丁、重打包、apksigner |
| `native-unpack` | Mach-O/ELF/PE 结构、UPX、内存 dump、反调试、字符串解密、OLLVM/VM |
| `crack-report` | 证据链 E-001、观察/推断/未知、复现步骤、交付物清单 |

## 安装

```bash
bash ~/Documents/hackerking/scripts/install-local.sh --profile desktop
```

或：

```bash
cd ~/.dsh/profiles/<profile>
pnpm add link:/Users/zhangsugang/Documents/hackerking/plugins/crack-lab
# 把 crack-lab 加进 package.json 的 dsh.profile.bundles
```

## 用法

```text
skill: crack-router
目标是一个 macOS app，试用 7 天，判断在本地，帮我出破解方案。
```

```text
skill: license-patch
这个 Mach-O 的序列号校验在哪，给我可复现的补丁脚本。
```

```text
skill: keygen-model
这个激活码是 16 位字母数字，客户端离线校验，帮我还原算法并写 keygen。
```

## 与其他插件的关系

- 方法论与模块路由：`reverse-skills`（46 技能）。
- 原生反编译引擎：`rea`（MCP）或 `ghidra-bridge`（GhidraMCP）。
- 本包只负责破解项目的阶段编排与交付规范，不重复上面的工具接入。

## 产物

所有产物写入工作区 `cases/<case>/`：`scope.md`、`sample/`、`notes/`、`evidence/`、`patches/`、`report.md`。插件目录只读。

## 许可

MIT。技能内容为本工作区原创；引用的工具与上游项目按各自许可证。
