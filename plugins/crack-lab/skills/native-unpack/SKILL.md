---
name: native-unpack
description: 原生脱壳：对 Mach-O、ELF、PE 做段熵与壳识别（UPX、VMProtect、Themida、OLLVM），UPX 脱壳与 lldb、Frida dump，绕过 ptrace、sysctl 与时间检测，用 unicorn 还原字符串，拆解平坦化与 VM 保护（unpack、UPX、lldb）。
---

## 适用

- 目标被加壳、混淆、反调试或字符串加密，静态反汇编读不出有效逻辑。
- 形态：Mach-O（含 iOS）、ELF（Android so、Linux）、PE（exe/dll）。
- 目标：拿到明文代码段、解出字符串、恢复可读控制流，再交给 license-patch 或 keygen-model。
- APK 整体加固先走 apk-crack；本技能处理其中的 so 与原生壳。

## 执行顺序

1. 基础体检：`file`、`rabin2 -I`、段表、熵。
2. 壳判定：UPX、VMProtect、Themida、OLLVM、自研壳。
3. 能静态脱的先脱：UPX 直接 `upx -d`。
4. 脱不了就 dump：lldb 或 Frida 抓内存镜像。
5. 过反调试：ptrace、sysctl、`isDebuggerPresent`、时间差。
6. 解字符串：动态 trace 或 unicorn 模拟。
7. 还原控制流：OLLVM 平坦化、VM handler。
8. 验证产物可分析，写移交说明。

## 1. 基础体检

```bash
file <SAMPLE>
rabin2 -I <SAMPLE>
rabin2 -S <SAMPLE> | head -40
otool -hv <BIN>
otool -l <BIN> | grep -E "LC_SEGMENT|__TEXT|__DATA|cryptid"
readelf -hS <ELF> | head -60
objdump -p <PE> | grep -i "DLL Name" | head -30
```

段熵快速判断：

```python
import collections, math, pathlib

data = pathlib.Path("<SAMPLE>").read_bytes()
for name, chunk in [("head", data[:1 << 20]), ("tail", data[-1 << 20:])]:
    c = collections.Counter(chunk)
    e = -sum(n / len(chunk) * math.log2(n / len(chunk)) for n in c.values())
    print(name, round(e, 3))
```

- 熵 > 7.2 视为加密或压缩；正常代码段约 6.0–6.8。
- `cryptid 1` 表示 iOS 加密段，先解密再分析。
- 段名异常（`UPX0`、`UPX1`、`.vmp`、`.themida`）直接进第 2 步。

## 2. 加壳识别

```bash
rabin2 -I <SAMPLE> | grep -i "packer\|stripped"
strings -a <SAMPLE> | grep -iE "UPX!|VMProtect|Themida|Enigma|ASPack|MPRESS|ollvm|bcf|fla" | head -20
rabin2 -S <SAMPLE> | awk '{print $1, $2, $3, $6, $7}' | head -30
```

| 壳/保护 | 特征 | 路径 |
| --- | --- | --- |
| UPX | `UPX!` magic、`UPX0/UPX1` 段 | 第 3 步 `upx -d` |
| VMProtect / Themida | 高熵段、导入表极小、入口跳外部段 | 动态 dump + API hook |
| OLLVM | 分发循环、状态变量、大量虚假块 | 第 7 步按关键路径还原 |
| 自研壳 | 入口在可写段、`mprotect` 后跳转 | Frida 在 `mprotect` 后 dump |
| Android 加固 | `libjiagu`、`libshella` | 转 apk-crack |

## 3. UPX 脱壳

```bash
upx -l <SAMPLE>
upx -d <SAMPLE> -o cases/<CASE>/work/unpacked
rabin2 -I cases/<CASE>/work/unpacked
shasum -a 256 cases/<CASE>/work/unpacked
```

- 报 `not packed by UPX` 但段名是 UPX：魔改过。先修 `UPX!` magic 与段名，再 `upx -d -f`。
- 脱壳产物单独记 hash，后续分析都基于它。

## 4. 内存 dump

lldb 脚本：

```bash
cat > cases/<CASE>/work/dump.lldb <<'EOF'
target create "<BIN>"
settings set target.process.stop-on-sharedlibrary-events false
breakpoint set -n main
run
image list -o -f
memory read --outfile cases/<CASE>/work/dump_text.bin <START> <END>
process continue
EOF
lldb -s cases/<CASE>/work/dump.lldb
```

Frida dump：

```js
var m = Process.getModuleByName("<MODULE>");
m.enumerateRanges("r-x").forEach(function (r, i) {
  var f = new File("/tmp/dump_" + i + "_" + r.base + ".bin", "wb");
  f.write(Memory.readByteArray(r.base, r.size));
  f.close();
  console.log(r.base, r.size);
});
```

- dump 点选在解密完成、跳回原入口之后：`mprotect` 返回处、`main` 首行、壳的 `jmp rax` 前。
- dump 只保证拿到明文用于静态分析；要可运行需按 program header 重拼，或直接用 Frida 内存态继续 hook。
- iOS 需要先处理 `cryptid`，否则 dump 出来仍是密文。

## 5. 反调试绕过

```js
// ptrace / PT_DENY_ATTACH
var pt = Module.findExportByName(null, "ptrace");
if (pt) Interceptor.attach(pt, { onLeave: function (r) { r.replace(0); } });

// sysctl: 清 P_TRACED 位
var sc = Module.findExportByName(null, "sysctl");
if (sc) {
  Interceptor.attach(sc, {
    onEnter: function (args) { this.info = args[2]; },
    onLeave: function (r) {
      try { this.info.add(32).writeU32(this.info.add(32).readU32() & ~0x800); } catch (e) {}
    }
  });
}

// Windows
var idp = Module.findExportByName("kernel32.dll", "IsDebuggerPresent");
if (idp) Interceptor.attach(idp, { onLeave: function (r) { r.replace(0); } });
```

lldb 侧绕过 `ptrace`：

```text
breakpoint set -n ptrace
breakpoint command add 1 -o "thread return 0" -o "continue"
run
```

时间检测（`mach_absolute_time`、`clock_gettime`、`QueryPerformanceCounter`）统一 hook 成固定增量，避免两次读数差超过阈值。

## 6. 字符串解密

先动态定位解密函数：明文写出前必有一次写内存，在 `memcpy`、`strcpy`、`std::string` 构造处下断，或 `frida-trace -f <BIN> -i "*decrypt*" -i "*decode*"`。

unicorn 模拟骨架（x86_64）：

```python
from unicorn import Uc, UC_ARCH_X86, UC_MODE_64
from unicorn.x86_const import UC_X86_REG_RDI

BASE, STACK = 0x100000, 0x200000
code = bytes.fromhex("<CODE_HEX>")
uc = Uc(UC_ARCH_X86, UC_MODE_64)
uc.mem_map(BASE, 0x10000)
uc.mem_map(STACK, 0x10000)
uc.mem_write(BASE, code)
uc.mem_write(BASE + 0x8000, b"\x00" * 0x100)
uc.reg_write(UC_X86_REG_RDI, BASE + 0x8000)
uc.emu_start(BASE, BASE + len(code), count=10000)
print(uc.mem_read(BASE + 0x8000, 0x80))
```

- arm64 换成 `UC_ARCH_ARM64`/`UC_MODE_ARM`，参数寄存器用 `UC_ARM64_REG_X0`。
- 依赖全局数据时把原文件对应段映射到相同虚拟地址，否则读到空。
- 解出的字符串连同地址记入 `evidence/E-040-strings.txt`。

## 7. OLLVM 平坦化

识别：函数入口初始化状态变量 → `while(true)` 分发 → `switch(state)` → 每块改 state 回跳。

拆解路径：

1. 定位 dispatcher：多前驱、间接跳转、`switch` case 数与真实逻辑块数不匹配。
2. 动态记录状态序列：断点打在 dispatcher 头部，打印状态寄存器。

```text
breakpoint set -n <DISPATCH_FN>
breakpoint command add 1 -o "register read x8" -o "continue"
```

3. 按状态序列把真实块排成线性流，忽略永假块。
4. 用反汇编器的脚本能力批量改图：IDA 的 `deflat.py`、Ghidra 的脚本、或自己写 IDAPython 重定向。
5. 只还原触发校验的那条路径，不追求整函数可读。

## 8. VM 保护

- 识别：opcode fetch（读 `[pc++]`）、handler 表、虚拟寄存器数组、dispatch 循环。
- 步骤：
  1. 定位 `vmentry`/`vmexit`，确认字节码来源（内嵌段或运行时解密）。
  2. dump handler 表，按 opcode 编号建索引。
  3. 每个 handler 记语义：加减、load/store、跳转、调用原生函数。
  4. 写 lifter 把 handler 序列翻译成 IR 或伪代码。
  5. 用真实输入跑一遍，比对输出验证语义。
- 成本高时退一步：只 hook VM 出口的原生 API（授权判断、字符串比较），不还原整台 VM。

## 失败分支

- **dump 基址漂移**：PIE/ASLR 下每次基址不同，先 `image list -o -f` 记录 slide，再按 slide 修正地址。
- **dump 出来仍是密文**：dump 点太早，后移到解密函数返回之后。
- **UPX 魔改**：修 magic 与段名仍失败，改用 lldb 在 `__libc_start_main` 前 dump。
- **attach 就退出**：反调试优先级高于分析，先按第 5 步处理，再重试。
- **`mprotect` 失败**：iOS 代码签名限制，改用 Frida 在用户态 hook，不做代码段改写。
- **OLLVM 全平坦化**：静态还原成本过高，转动态 trace 关键路径 + API hook。
- **VM handler 加密**：先解 handler 表，再谈语义；解不开就放弃还原，改从外部行为建模。

## 验收清单

- [ ] `file`、段表、熵值已记录，壳类型有结论
- [ ] 脱壳或 dump 产物有独立 sha256
- [ ] dump 点与基址/slide 已写明，可复现
- [ ] 反调试处理清单与实际 hook 日志一致
- [ ] 解出的字符串带地址入 evidence
- [ ] OLLVM/VM 至少还原出校验相关路径或明确标注未还原
- [ ] 产物能被反汇编器正常加载，关键函数可读
- [ ] 移交说明写明哪部分是明文、哪部分仍是黑盒
