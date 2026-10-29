---
name: keygen-model
description: 序列号算法还原：判定哈希、HMAC、RSA、椭圆曲线或自定义变换，用 z3 求解或纯 python 反推生成函数，产出 Python 与 C 两套 keygen CLI，覆盖长度、字符集、校验位与时间戳边界，以原版接受生成结果为验收（keygen、serial、z3、HMAC）。
---

## 适用

- 授权可离线验证：输入序列号后客户端自己算、自己判，不依赖网络回包。
- 目标形态：注册码、激活码、机器码绑定码、功能解锁码、离线 license 文件。
- 判定在服务端、签名用非对称私钥、序列号与硬件强绑定不可伪造时，转 license-patch 或服务端模拟，不在本技能硬啃。

## 执行顺序

1. 读 `scope.md`，确认“原版二进制接受生成的序列号”这一验收标准。
2. 抓校验现场：字符串、导入的密码学函数、校验入口。
3. 判定算法族，写进 `work/algorithm.md`。
4. 反推生成逻辑：逆变换、求解约束、还原常量表。
5. 先用 python 写出 `make_serial()`，与原版逐条比对。
6. 需要复杂约束时上 z3；需要交付二进制时补 C 版本。
7. 批量生成、去重、边界用例、负例。
8. 证据入 `evidence/`，报告写“算法还原”节。

## 1. 抓校验现场

```bash
BIN=<BIN>
rabin2 -zz "$BIN" | grep -iE "serial|key|activate|license|checksum|invalid|expired|trial" | head -40
rabin2 -i "$BIN" | grep -iE "CC_|SecKey|CryptoKit|EVP_|BCrypt|Crypt|SHA|HMAC"
nm -u "$BIN" 2>/dev/null | grep -iE "CC_SHA|CCCrypt|SecKey|EVP_|HMAC"
```

```bash
grep -rn --include=*.java -iE "MessageDigest|HmacSHA|Cipher|Base64|serial|activate" work/jadx/sources | head -40
```

拿到校验入口后，动态记录输入输出对，至少 5 组：

```bash
frida-trace -f <BIN> -i "*serial*" -i "*verify*" -i "*activate*"
```

## 2. 算法族判定

| 特征 | 算法 | 处理 |
| --- | --- | --- |
| 定长数字，末位像校验位 | Luhn / mod 10 / mod 11 | 直接写逆函数 |
| 分段 hex，长度 16/32/40 | MD5 / SHA1 / SHA256 截断 | 找盐，重算摘要 |
| 含 key 参数的摘要 | HMAC-SHA256 | key 在二进制常量或派生逻辑里 |
| 大整数、模幂、DER 常量 | RSA / ECDSA | 私钥不在本地 → 改校验或替换公钥 |
| 位运算乱序、移位异或 | 自定义变换 | 逐位记录，写逆变换 |
| 数组常量、下标映射 | 表格驱动 | dump 表，建字符映射 |
| 含时间或机器码 | 绑定 | 放宽窗口或伪造采集函数 |

## 3. z3 求解骨架

```python
from z3 import *

N = 16
s = Solver()
d = [BitVec(f"d{i}", 8) for i in range(N)]
for x in d:
    s.add(x >= ord("0"), x <= ord("9"))

for i, ch in enumerate("ACME"):
    s.add(d[i] == ord(ch))

# 按反编译结果替换：加权和 mod 97 == 0
s.add(Sum([ZeroExt(32, d[i]) * (i + 1) for i in range(N)]) % 97 == 0)

if s.check() == sat:
    m = s.model()
    print("".join(chr(m[d[i]].as_long()) for i in range(N)))
else:
    print("unsat")
```

```bash
python3 cases/<CASE>/work/solve.py
```

建模要点：

- 32 位溢出用 `BitVec(..., 32)` 配 `URem`/`UDiv`；有符号比较先确认位宽。
- 字符集是范围约束，不要只约束到单个字符。
- 校验含 `strlen` 分支时，先固定长度再求解。
- `unsat` 优先怀疑模型错（宽度、端序、取模方向），不是算法不可解。

## 4. 纯 python 反推

```python
import hashlib
import hmac


def luhn_cd(body: str) -> str:
    total = 0
    for i, ch in enumerate(reversed(body)):
        n = int(ch)
        if i % 2 == 0:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return str((10 - total % 10) % 10)


def serial_from_name(name: str, salt: bytes) -> str:
    digest = hmac.new(salt, name.lower().encode(), hashlib.sha256).digest()
    body = "".join(f"{b % 100:02d}" for b in digest[:8])
    return body + luhn_cd(body)

print(serial_from_name("acme-user", bytes.fromhex("<SALT_HEX>")))
```

- `salt` / `key` 从二进制常量里取，写成 `<SALT_HEX>` 占位，只填实测值。
- 生成函数写完立刻和动态抓到的 5 组输入输出比对，全中才算还原。

## 5. keygen CLI 骨架

```python
#!/usr/bin/env python3
import argparse
import hashlib
import hmac

SALT = bytes.fromhex("<SALT_HEX>")


def make_serial(name: str) -> str:
    digest = hmac.new(SALT, name.strip().lower().encode(), hashlib.sha256).digest()
    return "".join(f"{b:02X}" for b in digest[:8])


def main() -> None:
    ap = argparse.ArgumentParser(prog="keygen")
    ap.add_argument("name", help="用户名或机器码")
    ap.add_argument("-n", type=int, default=1)
    ap.add_argument("--check", metavar="SERIAL")
    a = ap.parse_args()
    if a.check:
        print("valid" if a.check == make_serial(a.name) else "invalid")
        return
    for i in range(a.n):
        print(make_serial(a.name if a.n == 1 else f"{a.name}{i}"))


main()
```

```bash
mkdir -p cases/<CASE>/patches/keygen && cd cases/<CASE>/patches/keygen
python3 keygen.py acme-user
python3 keygen.py acme-user --check "$(python3 keygen.py acme-user)"
```

## 6. 批量生成与去重

```bash
seq 1 500 | xargs -I{} python3 keygen.py "user{}" >> keys.txt
sort -u keys.txt -o keys.txt
awk '!seen[$0]++' keys.txt | wc -l
```

- 批量前确认生成函数对 5 组已知样本全对。
- 去重后抽 20 条喂原版二进制，命中率应为 100%；低于 100% 回第 4 步查边界。
- 每条验证记 `E-0xx`，格式：`name, serial, result`。

## 7. C 版本骨架

```c
#include <stdint.h>
#include <stdio.h>

static uint32_t fnv1a(const char *s) {
    uint32_t h = 2166136261u;
    while (*s) { h ^= (uint8_t)*s++; h *= 16777619u; }
    return h;
}

int main(int argc, char **argv) {
    if (argc < 2) return 1;
    uint32_t a = fnv1a(argv[1]);
    printf("%08X-%08X\n", a, a ^ 0xA5A5A5A5u);
    return 0;
}
```

```bash
cc -O2 -o cases/<CASE>/patches/keygen/keygen cases/<CASE>/patches/keygen/keygen.c
```

## 8. 边界条件

- 长度：最短/最长/空串/超长，原版是否截断。
- 字符集：大小写、`-` 与空格、全角字符、前后空白是否 trim。
- 校验位：末位是否参与摘要，是否区分大小写。
- 时间戳：是否写入过期字段，能否固定为远期时间。
- 机器码：绑定 MAC、磁盘序列号或安装 ID，能否固定输入。
- 版本位与黑名单：是否编码 edition/席位，是否拒全 0、全 F。

## 失败分支

- **动态抓不到输入输出**：校验被内联，改断点看寄存器，或在字符串比较处下断。
- **z3 unsat**：模型宽度或运算语义错；32 位有符号换成 `BitVec` + `URem` 重试。
- **算法含非对称私钥**：私钥不在客户端，改校验点或替换公钥后自签。
- **本地通过、服务端驳回**：存在二次校验，转服务端模拟，记录请求字段。
- **机器码每次变化**：采集函数被 hook 或随机化，先定位采集点再固定。
- **字符串运行时才解密**：转 native-unpack 的字符串解密节，先拿明文。

## 验收清单

- [ ] 校验入口与 `<CHECK_FN>` 已定位，5 组输入输出已记录
- [ ] 算法族判定写入 `work/algorithm.md`，含常量与盐
- [ ] `make_serial()` 对已知样本 100% 命中
- [ ] keygen CLI 可单条生成、可 `--check` 自检
- [ ] 批量生成已去重，抽样 20 条由原版二进制验证通过
- [ ] 边界条件逐项测过，负例有记录
- [ ] C 版本（如需交付）编译通过且输出一致
- [ ] 关键命令、输入 hash、输出片段进 evidence
