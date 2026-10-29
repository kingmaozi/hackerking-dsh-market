---
name: apk-crack
description: APK 破解：jadx、apktool 解包，按 manifest 与 smali 定位签名校验、root 检测、证书固定，Frida、objection hook Java 与 native，补丁后 zipalign、apksigner 重签，处理 split/so（APK、jadx、Frida）。
---

## 适用

- 目标形态：Android APK、XAPK、split APK、带 native so 的加固包。
- 本地判定走本技能：签名校验、root/模拟器检测、证书固定、会员/试用开关、风控降级。
- 服务端判定、加固壳脱壳、so 内 VM 保护分别转 keygen-model、native-unpack、native-unpack。

## 执行顺序

1. 环境自检：jadx、apktool、adb、frida、objection、apksigner 缺哪个补哪个。
2. 解包：`unzip -l`、`jadx`、`apktool d`，证据入 `E-020`。
3. Manifest 与权限：确认包名、debuggable、出口组件。
4. 定位校验：签名、root、pinning、风控、会员判断。
5. 动态验证：Frida hook 拿到调用点与返回值。
6. smali 补丁：优先改分支，其次改返回值。
7. 重打包、zipalign、apksigner、安装验证。
8. 记录证据、回滚命令与报告。

## 0. 环境安装

当前机器未装 jadx 与 frida 时，先补齐：

```bash
brew install jadx apktool
brew install --cask android-platform-tools android-commandlinetools
python3 -m pip install --user frida-tools objection frida-dexdump
```

`zipalign`、`apksigner` 在 Android build-tools 里：

```bash
sdkmanager "build-tools;34.0.0" "platform-tools"
export PATH="$HOME/Library/Android/sdk/build-tools/34.0.0:$PATH"
```

```bash
jadx --version; apktool --version; adb version; frida --version; objection version; apksigner version
```

## 1. 解包与 manifest

```bash
CASE=<CASE>
APK=<SAMPLE>.apk
mkdir -p cases/$CASE/work
unzip -l "$APK" | tee cases/$CASE/evidence/E-020-apk-list.txt
jadx -d cases/$CASE/work/jadx --show-bad-code "$APK"
apktool d -f -o cases/$CASE/work/apktool "$APK"
```

```bash
grep -E "package=|android:debuggable|uses-permission|android:name=\"[^\"]*(Security|Root|Frida|Proxy|Integrity)" cases/$CASE/work/apktool/AndroidManifest.xml | head -40
unzip -l "$APK" | grep -E "lib/|assets/" | head -30
```

- `jadx` 报错不影响 smali 线；资源混淆导致 `apktool` 失败时加 `-r`（不反编译资源）或 `-s`（不反编译 dex）。
- `assets/` 里出现 `*.dex`、`*.jar`、加密 blob，说明有二次加载，记入保护指纹。
- `lib/` 下按 ABI 分目录，后续 so 分析只取目标 ABI。

## 2. 定位校验点

```bash
grep -rn --include=*.java -iE "getPackageInfo|GET_SIGNATURES|GET_SIGNING_CERTIFICATES|signatures|MessageDigest" cases/$CASE/work/jadx/sources | head -50
grep -rn --include=*.java -iE "isRooted|/su|magisk|frida|xposed|substrate|ptrace" cases/$CASE/work/jadx/sources | head -50
grep -rn --include=*.java -iE "CertificatePinner|TrustManager|SSLContext|X509TrustManager" cases/$CASE/work/jadx/sources | head -50
grep -rn --include=*.java -iE "ro.kernel.qemu|Build.FINGERPRINT|isEmulator|detect" cases/$CASE/work/jadx/sources | head -50
grep -rn --include=*.java -iE "isVip|isPro|isPremium|trial|license|activate|purchase" cases/$CASE/work/jadx/sources | head -50
```

smali 侧确认分支：

```bash
find cases/$CASE/work/apktool -name "*.smali" -exec grep -ln "isValid\|License\|signature" {} + | head -20
grep -n "if-eqz\|if-nez\|invoke-.*getPackageInfo\|invoke-.*signatures" \
  cases/$CASE/work/apktool/smali*/com/example/app/license/*.smali | head -40
```

定位结论写成三行：类名、方法签名、返回值语义（`Z` 里 1 成功还是 0 成功）。

## 3. Frida hook

```js
// hook.js
Java.perform(function () {
  var L = Java.use("com.example.app.license.LicenseManager");
  L.isValid.implementation = function () {
    console.log("[*] isValid called -> true");
    return true;
  };

  var S = Java.use("com.example.app.security.SignatureCheck");
  S.verify.implementation = function () {
    console.log("[*] SignatureCheck.verify -> true");
    return true;
  };
});
```

```bash
PKG=com.example.app
frida -U -f "$PKG" -l hook.js --no-pause
```

objection 快速试探：

```bash
objection -g "$PKG" explore
# android root disable
# android hooking watch class_method com.example.app.license.LicenseManager.isValid --dump-args --dump-return
```

native 层：

```js
var addr = Module.findExportByName("libnative.so", "Java_com_example_app_Native_check");
if (addr) {
  Interceptor.attach(addr, {
    onEnter: function (a) { console.log("[*] native check", a[0], a[1]); },
    onLeave: function (r) { console.log("    ret", r); r.replace(ptr(1)); }
  });
}
```

## 4. smali 补丁

方法 `isValid()Z` 强制返回 true：

```smali
.method public isValid()Z
    .locals 1
    const/4 v0, 0x1
    return v0
.end method
```

分支反转（`if-eqz` 与 `if-nez` 互换）：

```bash
# 原: if-eqz v0, :cond_fail  → 改 if-nez v0, :cond_fail
sed -i '' 's/if-eqz v0, :cond_fail/if-nez v0, :cond_fail/' \
  cases/$CASE/work/apktool/smali/com/example/app/license/LicenseManager.smali
```

签名校验优先改返回值，不去改 SHA256 常量：

```smali
# 原 invoke-static {v1}, Lutil/Sig;->check([B)Z  → 结果强制 1
const/4 v1, 0x1
```

每处补丁记录：文件、方法、原指令、新指令、行号，进 `cases/$CASE/evidence/E-022-smali-patch.txt`。

## 5. 重打包与签名

```bash
cd cases/$CASE
apktool b -o cases/$CASE/work/patched.apk cases/$CASE/work/apktool
zipalign -p -f 4 cases/$CASE/work/patched.apk cases/$CASE/work/patched-aligned.apk
keytool -genkeypair -keystore cases/$CASE/work/test.jks -alias test -keyalg RSA -keysize 2048 \
  -validity 3650 -storepass test123 -keypass test123 -dname "CN=test"
apksigner sign --ks cases/$CASE/work/test.jks --ks-pass pass:test123 \
  --out cases/$CASE/work/signed.apk cases/$CASE/work/patched-aligned.apk
apksigner verify --print-certs cases/$CASE/work/signed.apk
adb install -r -d cases/$CASE/work/signed.apk
```

- `zipalign -p` 保证 so 按页对齐，缺 `-p` 时 `extractNativeLibs=false` 的包会启动失败。
- 重签后签名摘要变化，若原包校验自身签名，必须同时补第 2 步定位到的校验点。
- 保留 `cases/$CASE/work/test.jks` 与口令在 `cases/$CASE/work/keystore.txt`，重装与回滚都要用。

## 6. split APK 与 so

```bash
unzip -o "$APK" 'lib/*' -d cases/$CASE/work/lib
file cases/$CASE/work/lib/arm64-v8a/*.so
adb install-multiple -r cases/$CASE/work/split/base.apk cases/$CASE/work/split/split_config.arm64_v8a.apk
```

- split 包只改 `base.apk` 里的 dex，其余 split 保持原样，所有 split 用同一签名密钥重签。
- so 改动先走 native-unpack，再放回 `cases/$CASE/work/apktool/lib/<ABI>/`，重打包时自动带入。
- 只取真机 ABI（`adb shell getprop ro.product.cpu.abi`），不要全 ABI 一起替换。

## 7. 安装验证

```bash
adb shell pm list packages | grep "$PKG"
adb logcat -c
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1
adb logcat -d | grep -iE "FATAL|frida|license|signature|SecurityException" | tail -30
adb exec-out screencap -p > evidence/E-030-screen.png
```

验证矩阵：原版未解锁、补丁版解锁、补丁版空输入不崩溃、冷启动仍解锁、卸载重装仍解锁。

## 失败分支

- **加固壳**（`libjiagu`、`libshella`、`libDexHelper`）：jadx 只见壳类。用 `frida-dexdump -U -f "$PKG"` dump 运行时 dex，再反编译。
- **抽取壳**：smali 方法体为 `nop`。运行时 dump dex 后按类名回填，或在 Frida 里直接 hook 空实现的原方法。
- **反调试**：先 hook `ptrace`，或改用 Magisk + Zygisk + Shamiko 环境；不要在原包里硬改检测点。
- **模拟器检测**：换真机；必须用模拟器时 hook `Build.FINGERPRINT`、`ro.kernel.qemu` 读取点。
- **重签后登录失败**：签名参与服务端校验，本地补丁无效，转服务端模拟或协议还原。
- **apktool 回编译失败**：资源混淆导致 aapt2 报错，改 `--no-res` 只打 dex，或用 zip 替换 `classes.dex` 后重签。
- **安装失败**：`INSTALL_FAILED_INVALID_APK` 多为漏 zipalign 或 v2 签名；低 targetSdk 用 `adb install --bypass-low-target-sdk-block -r -d cases/$CASE/work/signed.apk`。
- **Play Integrity / SafetyNet**：服务端判定，本地 patch 结果不变，记录为已知边界。

## 验收清单

- [ ] 环境版本已记录，缺项已补或标缺口
- [ ] APK 列表、manifest、ABI 信息入 evidence
- [ ] 校验点类名、方法签名、返回值语义已定位
- [ ] Frida hook 日志能证明调用发生且返回值被改
- [ ] smali 补丁有原指令/新指令对照，可复现
- [ ] 重打包产物通过 `apksigner verify`
- [ ] 真机安装并冷启动验证通过，logcat 无 FATAL
- [ ] split 与 so 处理方式已写明
- [ ] 签名密钥与回滚方式已记录
