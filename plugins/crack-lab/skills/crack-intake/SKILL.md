---
name: crack-intake
description: 破解接单建档：判定 app、PE、APK、IPA、Electron、固件、加密狗或 license server 目标，接管样本、算 sha256、采集结构、识别加壳混淆反调试指纹、预检工具链、选定补丁或 keygen 路线并落盘 scope.md（intake、triage、fingerprint）。
---

## 适用

- 样本刚进工作台、还没有任何结论时先跑本技能：先分类、再定路线，避免一上来就开反汇编器乱翻。
- 覆盖形态：macOS `.app`/`.dmg`/Mach-O、Windows PE（exe/dll/sys）、Android APK/XAPK、iOS IPA、Electron（`app.asar`）、Node/JS 混淆包、嵌入式固件、USB 加密狗配套程序、license server 客户端。
- 本技能只产出判断与档案，样本保持原样；补丁、keygen、脱壳分别交给 license-patch、keygen-model、apk-crack、native-unpack。

## 执行顺序

1. 预检：`bash scripts/preflight.sh`，缺失工具写进 scope.md，不带着工具缺口改路线。
2. 建案：`bash scripts/new-case.sh <CASE> <SAMPLE>`。
3. 校验样本：确认 `cases/<CASE>/sample/` 内文件，算 sha256，`file` 定型。
4. 结构采集：`rabin2 -I`、`otool -L`、PE 导入表、APK badging、asar 列表。
5. 保护指纹：加壳 / 混淆 / 反调试 / 反 VM / 签名校验 / 完整性校验。
6. 路线选择：静态补丁、动态 hook、算法还原、服务端模拟，四选一并写下最小可验证目标。
7. 落盘 `scope.md`，证据从 E-001 编号，移交下一技能。

## 1. 工具预检

```bash
bash scripts/preflight.sh
```

预检输出按下面这张表核对，缺一项就在 scope.md 记一行，并写明替代命令：

| 工具 | 用途 | 缺失后果 |
| --- | --- | --- |
| `file`/`shasum` | 定型与指纹 | 建档受阻，必须先补 |
| `rabin2`（radare2） | Mach-O/PE/ELF/APK 统一体检 | 退化为 `otool`/`objdump` |
| `otool`/`nm`/`codesign` | macOS 结构与签名 | 补丁后重签会失效 |
| `jadx`/`apktool` | APK 反编译与重打包 | 只能走 Frida 动态 |
| `frida`/`objection`/`adb` | 动态 hook 与安装 | APK 线只剩静态补丁 |
| `lldb` | Mach-O 动态调试 | 反调试样本难推进 |
| `python3`/`z3` | 补丁脚本与约束求解 | keygen 线受限 |

macOS 常用补齐命令（只装缺的）：

```bash
brew install radare2 jadx apktool
brew install --cask android-platform-tools
python3 -m pip install --user frida-tools objection z3-solver
```

## 2. 建案与目录

```bash
bash scripts/new-case.sh <CASE> <SAMPLE>
mkdir -p cases/<CASE>/work
```

`<CASE>` 用 `YYYYMMDD-短名`，例如 `20261019-sampleapp`。脚本会复制样本、算 sha256、生成 scope/report 骨架，建完确认：

```text
cases/<CASE>/
  sample/      原始样本（唯一真源，只读）
  notes/       静态/动态记录
  work/        解包、反编译、dump（new-case.sh 创建）
  patches/     补丁脚本与重打包产物
  evidence/    E-*.txt 命令与输出
  scope.md     路线与范围
  report.md    最终报告
```

```bash
ls -la cases/<CASE>
```

`sample/` 建议只读：`chmod -R a-w cases/<CASE>/sample`，需要改时复制到 `work/`。

## 3. 样本接管

```bash
cd cases/<CASE>/sample
xattr -dr com.apple.quarantine . 2>/dev/null || true
S=$(basename <SAMPLE>)
shasum -a 256 "$S" | tee ../evidence/E-001-sha256.txt
file "$S" | tee -a ../evidence/E-001-sha256.txt
```

- 原始 hash 同时写进 `scope.md` 与 `report.md`；补丁产物单独再算一次。
- 样本只保留一份，`work/`、`patches/` 全部由它派生。

## 4. 类型判定

先 `file`，再按形态跑对应命令，输出统一 tee 到 `cases/<CASE>/evidence/E-002-format.txt`：

```bash
cd ../../..   # 回工作区根
# macOS app
APP=$(find cases/<CASE>/sample -maxdepth 2 -name "*.app" | head -1)
defaults read "$APP/Contents/Info.plist" CFBundleExecutable
lipo -info "$APP/Contents/MacOS/$(defaults read "$APP/Contents/Info.plist" CFBundleExecutable)"
otool -L "$APP/Contents/MacOS/"*

# Mach-O / ELF / PE 单文件
rabin2 -I <BIN> | tee -a cases/<CASE>/evidence/E-002-format.txt
rabin2 -S <BIN> | head -30
objdump -p <BIN> 2>/dev/null | grep -i "DLL Name" | head -30

# APK
unzip -l <SAMPLE>.apk | tee -a cases/<CASE>/evidence/E-002-format.txt
aapt2 dump badging <SAMPLE>.apk 2>/dev/null | head -20 || true

# IPA
unzip -l <SAMPLE>.ipa | head -20
ls Payload/*.app 2>/dev/null

# Electron
ls -la <APP>/Contents/Resources/
npx asar list <APP>/Contents/Resources/app.asar 2>/dev/null | head -20 || strings app.asar | head -20

# JS
head -c 400 <SAMPLE>.js; grep -c "sourceMappingURL" <SAMPLE>.js

# firmware
file <SAMPLE>.bin; strings -a <SAMPLE>.bin | head -50

# dongle
system_profiler SPUSBDataType | grep -iE "vendor|product|serial" | head -30
ls /dev/cu.* /dev/tty.* 2>/dev/null

# license server 客户端
strings -a <BIN> | grep -iE "https?://|/api/|activate|license" | head -30
```

`aapt2`、`binwalk`、`asar` 未安装时用注释里的退化命令，scope.md 里标注“精度下降”，不要伪造输出。

## 5. 保护指纹

一次性采集，关键输出 tee 到 `cases/<CASE>/evidence/E-003-protection.txt`：

```bash
BIN=<BIN>
rabin2 -I "$BIN" | grep -iE "packer|canary|nx|pic|stripped"
nm -m "$BIN" 2>/dev/null | head -5
otool -l "$BIN" | grep -A3 LC_ENCRYPTION_INFO
strings -a "$BIN" | grep -iE "ptrace|PT_DENY_ATTACH|sysctl|isDebuggerPresent|frida|xposed|substrate|jailbreak|magisk|cycript" | head -30
codesign -dv --verbose=4 <APP> 2>&1 | head -20
codesign --verify --deep --strict <APP> 2>&1 | head
unzip -l <SAMPLE>.apk | grep -E "lib/|assets/" | head -30
```

判定表：

| 指纹 | 判定依据 | 影响 |
| --- | --- | --- |
| UPX / VMProtect / Themida | 段名、`strings` 特征、入口跳转 | 先走 native-unpack |
| OLLVM 平坦化 | 分发循环 + 状态变量 + 虚假块 | 优先动态 hook，静态只补单点 |
| 符号全剥离 | `rabin2 -s` 数量极少 | 靠字符串与 xref 定位 |
| 反调试 | `ptrace`、`sysctl`、`isDebuggerPresent` | 先过反调试再补丁 |
| 反 VM / 反模拟器 | 设备指纹、`ro.kernel.qemu` | 真机或 hook 检测函数 |
| 签名校验 | `codesign` 校验代码段 hash | 补丁必须重签并补校验点 |
| 自校验 | 启动时读自身文件算 hash | 双点补丁或 hook 比较函数 |
| 服务端校验 | 客户端只发请求、无本地判定 | 服务端模拟或协议还原 |
| APK 加固 | 壳类、`libjiagu`、`libshella` | 走 apk-crack 失败分支 |

## 6. 路线选择

按下面顺序判定，命中即停：

| 条件 | 路线 | 交接 |
| --- | --- | --- |
| 单点布尔校验、字符串可定位 | 静态补丁 | license-patch |
| 校验分散、多线程、VM 化 | 动态 hook | license-patch + native-unpack |
| 序列号可离线验证 | 算法还原 | keygen-model |
| 激活必须问服务端 | 服务端模拟 | keygen-model 协议节 |
| APK 签名 / root / 风控 | smali 补丁 + Frida | apk-crack |
| 壳或 VM 保护挡住静态 | 脱壳 | native-unpack |

每条路线补一句“最小可验证目标”，例如：
- 静态补丁：任意用户名 + 固定序列号能进主界面。
- keygen：原版未打补丁的二进制接受生成的序列号。
- 服务端模拟：本地起 mock server，客户端显示已激活。

## 7. scope.md 落盘

```bash
cat > cases/<CASE>/scope.md <<'EOF'
# <CASE> scope

- 样本: <SAMPLE>
- sha256: <HASH>
- 类型: macOS app / PE / APK / IPA / Electron / JS / firmware / dongle / license server
- 架构: arm64 / x86_64 / universal
- 工具缺口: 无 / 列出
- 保护指纹: 加壳=..., 反调试=..., 签名校验=..., 自校验=...
- 路线: 静态补丁 / 动态 hook / 算法还原 / 服务端模拟
- 最小可验证目标: ...
- 证据索引: E-001 sha256, E-002 结构, E-003 保护, ...
- 回滚点: sample/ 原件 + git commit <SHA>
- 已知未知: ...
EOF
```

## 失败分支

- **hash 不一致**：停止分析，重取样本，记 `E-004-hash-mismatch`，不覆盖已有证据。
- **`.app` 打不开**：先 `xattr -dr com.apple.quarantine <APP>`；仍失败就直接跑 `Contents/MacOS/<BIN>` 并记录。
- **FAT/多架构**：`lipo -thin arm64 <BIN> -output cases/<CASE>/work/<BIN>.arm64`，报告注明只分析该架构。
- **样本是安装器**：先静默解包（`pkgutil --expand`、`7z x`、`unar`），再对内部 payload 重新走第 3 步。
- **只有 split APK**：不要合并后当新样本，按 apk-crack 的 split 流程逐包分析。
- **工具装不上**：scope.md 标缺口，用替代命令并注明精度损失，不阻塞建档。
- **样本一跑就崩溃**：确认架构、依赖库（`otool -L`）、运行时目录，再判断是否为反调试触发。

## 验收清单

- [ ] `cases/<CASE>/sample/` 内样本 sha256 已记录，原件未被修改
- [ ] `file` + `rabin2 -I`（或等价）输出已进 evidence
- [ ] 目标类型、架构、依赖库已写明
- [ ] 保护指纹表逐项有结论或标“未知”
- [ ] 路线与最小可验证目标已写入 scope.md
- [ ] 工具缺口与替代方案已列出
- [ ] 证据编号连续，E-001 为 sha256
- [ ] 回滚点（原件路径 + commit）已记录
