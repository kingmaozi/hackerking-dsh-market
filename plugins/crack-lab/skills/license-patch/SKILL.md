---
name: license-patch
description: 授权补丁：Mach-O 与 PE 上用 strings、rabin2、otool 定位 CHECK_FN，记录 OFFSET 与原字节，python3 做字节补丁，macOS 走 codesign 重签，PE 重算校验和，跑原版失败、补丁成功与负例验证后回滚（license patch、Mach-O、PE）。
---

## 适用

- 授权判断在本地完成：布尔返回值、试用天数、功能位、注册码比对，都走本技能。
- 两类目标：macOS `.app`/Mach-O（arm64、x86_64、universal）与 Windows PE（exe/dll）。
- 授权在服务端判定、序列号可离线生成、目标被壳或 VM 保护时，分别转 keygen-model、keygen-model、native-unpack。

## 执行顺序

1. 读 `cases/<CASE>/scope.md`，确认 `<CHECK_FN>` 线索与最小可验证目标。
2. 静态找提示串，交叉引用到校验函数。
3. 动态确认：断点或 `frida-trace` 看返回值与分支走向。
4. 在反汇编里定位条件跳转，记录文件 `OFFSET`、原始字节、目标 `PATCH_BYTE`。
5. 复制样本到 `patches/`，跑 python 补丁脚本，保留 `.bak`。
6. macOS 重签名并去 quarantine；Windows 重算 PE 校验和、按需重签。
7. 跑验证矩阵，三组结果入 evidence，写回滚命令与报告破解路径节。

## 1. 定位校验点（macOS）

```bash
BIN=<BIN>
rabin2 -zz "$BIN" | grep -iE "trial|expired|license|serial|activation|invalid|unregistered|注册|试用|激活" | head -40
strings -a -t x "$BIN" | grep -iE "license|serial|activation|trial|expired" | head -40
nm -m "$BIN" 2>/dev/null | grep -iE "valid|check|license|serial|activate|trial" | head -40
otool -tvV "$BIN" | sed -n '/_validateLicense/,/ret/p' | head -80
```

提示串拿到偏移后进 Hopper / IDA / Ghidra：

- Hopper：Strings 面板搜关键词 → `References to` → 落到函数。
- IDA：`Shift+F12` 字符串窗 → 双击 → `X` 交叉引用。
- Ghidra：Search → For Strings → 双击 → `Ctrl+Shift+F` 找引用。

确认三件事：函数名或符号、返回值语义（1 成功还是 0 成功）、失败分支落点。

## 2. 定位校验点（Windows PE）

```bash
rabin2 -zz <SAMPLE>.exe | grep -iE "serial|license|expired|trial|activation|invalid" | head -40
objdump -p <SAMPLE>.exe | grep -iE "DLL Name|Subsystem" | head -30
rabin2 -i <SAMPLE>.exe | grep -iE "RegQueryValue|GetVolumeInformation|CreateFile|WinVerifyTrust"
```

- 导入表出现 `WinVerifyTrust`、`CryptVerifySignature` 说明有签名流程。
- 出现 `RegQueryValueEx` 说明授权信息可能落在注册表，先观察键路径再决定补丁点。
- Ghidra 导入时确认基址；PE 默认 `0x140000000`，与文件偏移换算必须显式记录。

## 3. 动态确认

```bash
lldb <BIN>
(lldb) breakpoint set -n "-[LicenseManager validateLicense:]"
(lldb) run
(lldb) bt
(lldb) register read x0 x1
(lldb) disassemble --frame
```

```bash
frida-trace -f <BIN> -i "*valid*" -i "*license*" -i "*trial*"
```

Windows 有符号时同样用 lldb 下断；没符号就按字符串交叉引用在反汇编器里跳转，或直接进第 4 步静态判定分支。

## 4. 补丁点语义

| 目标 | arm64 | x86_64 |
| --- | --- | --- |
| 强制返回 true | `mov w0,#1; ret` = `20 00 80 52 C0 03 5F D6` | `mov eax,1; ret` = `B8 01 00 00 00 C3` |
| 强制返回 false | `mov w0,#0; ret` = `00 00 80 52 C0 03 5F D6` | `xor eax,eax; ret` = `31 C0 C3` |
| 条件跳转改直跳 | `cbz`/`cbnz` 换成 `b` | `jz` `74` → `jmp` `EB`，`jnz` `75` → `EB` |
| 抹掉一条指令 | `nop` = `1F 20 03 D5` | `nop` = `90` |

改条件跳转优先，改函数返回值次之，插入代码最后。改跳转时确认目标在 ±128MB（arm64 `b`）或 rel8（x86 `EB`）范围内。

## 5. 补丁卡记录

| 字段 | 值 |
| --- | --- |
| 文件 | `sample/<BIN>` |
| 架构 | arm64 / x86_64 |
| 文件偏移 OFFSET | `0x<OFFSET>` |
| 虚拟地址 | `0x...`（基址 `0x...`） |
| 原始字节 | `<ORIG_BYTES>` |
| 补丁字节 PATCH_BYTE | `<PATCH_BYTE>` |
| 指令语义 | `cbz w0,#fail` → `b #ok` |
| 校验函数 | `<CHECK_FN>` |
| 关联证据 | E-0xx |

## 6. python 字节补丁

```bash
mkdir -p cases/<CASE>/patches
cp -a cases/<CASE>/sample/<BIN> cases/<CASE>/patches/<BIN>
chmod u+w cases/<CASE>/patches/<BIN>
```

```python
#!/usr/bin/env python3
import argparse, hashlib, shutil, sys, time
from pathlib import Path

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

ap = argparse.ArgumentParser()
ap.add_argument("target")
ap.add_argument("--offset", required=True, help="文件偏移")
ap.add_argument("--expect", required=True, help="原始字节 hex，如 7412")
ap.add_argument("--patch", required=True, help="替换字节 hex")
ap.add_argument("--dry-run", action="store_true")
a = ap.parse_args()

off, exp, new = int(a.offset, 16), bytes.fromhex(a.expect), bytes.fromhex(a.patch)
if len(exp) != len(new):
    sys.exit("长度不一致：补丁字节必须与原始字节等长")
p = Path(a.target)
data = bytearray(p.read_bytes())
if data[off:off + len(exp)] != exp:
    sys.exit(f"偏移 {a.offset} 不匹配，实际 {data[off:off + len(exp)].hex()}")
print("before", sha(p))
if a.dry_run:
    print("dry-run ok，跳过写盘")
    sys.exit(0)
bak = p.with_name(f"{p.name}.bak.{int(time.time())}")
shutil.copy2(p, bak)
data[off:off + len(exp)] = new
p.write_bytes(data)
p.chmod(0o755)
print("backup", bak)
print("after", sha(p))
```

把脚本存为 `cases/<CASE>/patches/patch.py`，先 dry-run 再写盘：

```bash
python3 cases/<CASE>/patches/patch.py cases/<CASE>/patches/<BIN> \
  --offset <OFFSET> --expect <ORIG_BYTES> --patch <PATCH_BYTE> --dry-run
python3 cases/<CASE>/patches/patch.py cases/<CASE>/patches/<BIN> \
  --offset <OFFSET> --expect <ORIG_BYTES> --patch <PATCH_BYTE> \
  | tee cases/<CASE>/evidence/E-010-patch.txt
```

## 7. macOS 重签名

```bash
APP=cases/<CASE>/patches/<APP>
codesign -d --entitlements :- "$APP" > cases/<CASE>/evidence/entitlements.plist 2>/dev/null || true
codesign --force --deep --sign - --entitlements cases/<CASE>/evidence/entitlements.plist "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
xattr -dr com.apple.quarantine "$APP"
```

有 hardened runtime 时补 `--options runtime`；library validation 拦第三方 dylib 时加 entitlement `com.apple.security.cs.disable-library-validation`。重签后 `codesign -dv --verbose=4` 输出入 evidence。

## 8. Windows 校验和与签名

```bash
python3 -m pip install --user pefile   # 首次
python3 - <<'PY'
import pefile
pe = pefile.PE("cases/<CASE>/patches/app.exe")
pe.OPTIONAL_HEADER.CheckSum = pe.generate_checksum()
pe.write("cases/<CASE>/patches/app.exe")
print("checksum", hex(pe.OPTIONAL_HEADER.CheckSum))
PY
```

字节一改，Authenticode 摘要即失效；需要签名时先 `brew install osslsigncode`，再用测试证书重签：`osslsigncode sign -certs cases/<CASE>/patches/cert.pem -key cases/<CASE>/patches/key.pem -in cases/<CASE>/patches/app.exe -out cases/<CASE>/patches/app-signed.exe`。不重签也能运行的场景很多，但任何读签名的逻辑都会看到失效状态，需在报告写明。

## 9. 验证矩阵

| 用例 | 输入 | 期望 | 证据 |
| --- | --- | --- | --- |
| 原版 + 无效输入 | 任意错误序列号 | 失败/试用提示 | E-020 |
| 原版 + 有效输入（若有） | 已知正版序列号 | 成功 | E-021 |
| 补丁版 + 无效输入 | 同一错误序列号 | 成功 | E-022 |
| 补丁版 + 空输入 | 空串 | 不崩溃，走正常失败路径 | E-023 |
| 补丁版冷启动 | 重启后再进 | 仍成功 | E-024 |
| 负例：只改一处 | 无效输入 | 仍失败 → 存在第二个校验点 | E-025 |

```bash
cases/<CASE>/patches/<BIN> --serial INVALID > cases/<CASE>/evidence/E-022.txt 2>&1
echo "exit=$?" >> cases/<CASE>/evidence/E-022.txt
```

## 10. 回滚

```bash
cp -a cases/<CASE>/sample/<BIN> cases/<CASE>/patches/<BIN>
codesign --force --deep --sign - cases/<CASE>/patches/<APP>
shasum -a 256 cases/<CASE>/patches/<BIN>
```

Windows 侧用 `cp -a` 覆盖后按原 hash 校验；回滚命令写进 `patches/rollback.sh`，并在报告给出执行结果。

## 失败分支

- **偏移不匹配**：多半把虚拟地址当文件偏移。用 `rabin2 -S` 算段映射，`file_off = vaddr - sec.vaddr + sec.paddr`。
- **补丁后崩溃**：改到指令中间或跳转目标越界。回反汇编确认指令边界，用整条指令等长替换。
- **签名后仍打不开**：`codesign --verify` 看报错；常见是嵌套组件未重签，对 `.app` 内每个 Mach-O 逐个 `--force --sign -`。
- **改完仍提示未激活**：存在第二校验点或自校验 hash；`frida-trace` 全量跟一遍，或转动态 hook。
- **更新后失效**：补丁针对具体版本，记录版本号与 sha256，升级后重做。
- **PE 改完立刻退出**：检查 TLS 回调与入口点前校验；必要时改导入函数而非入口代码。
- **arm64e**：指针带 PAC，改函数指针无效，改指令分支。

## 验收清单

- [ ] `<CHECK_FN>` 已定位，函数地址与文件偏移都记录
- [ ] 补丁卡字段齐全，`<OFFSET>`、原始字节、`<PATCH_BYTE>` 可复现
- [ ] 补丁脚本先 `--dry-run` 通过，再实际写盘
- [ ] `.bak` 备份存在，原样本 hash 未变
- [ ] macOS 重签名通过 `codesign --verify --deep --strict`
- [ ] Windows 校验和已重算，签名状态已说明
- [ ] 验证矩阵覆盖原版失败、补丁成功、负例三组
- [ ] 回滚命令已实测，命令与输出入 evidence
