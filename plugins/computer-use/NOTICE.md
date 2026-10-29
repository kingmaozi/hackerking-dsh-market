# NOTICE

本包是**自研实现**，没有拷贝任何第三方源码或二进制。

## 运行时依赖

| 组件 | 本机路径 | 许可 | 用途 |
|---|---|---|---|
| `screencapture`、`sips`、`osascript`、`pbcopy`、`pbpaste` | `/usr/sbin`、`/usr/bin` | Apple macOS 系统组件（随系统） | 截屏、缩放、键位组合、剪贴板 |
| `cliclick` 5.1 | `/opt/homebrew/bin/cliclick` | BSD-3-Clause（Carsten Blüm，https://www.bluem.net/jump/cliclick/） | 指针移动/点击/拖拽、逐字键入 |
| `python3` + `pyobjc-framework-Quartz` | `/opt/homebrew/Caskroom/miniforge/base/bin/python3` | Python PSF / pyobjc MIT | 滚轮事件、窗口枚举、TCC 权限与显示器探针 |

这些都不随本包分发；缺失时对应工具会明确报错，不影响其它工具。

## 未包含

- 不包含 ZCode 的 `ZCode Computer Use.app`（闭源 helper，另有其授权），也不调用它。
- 不包含任何样本、密钥、证书、provisioning profile 或第三方二进制。

## 参考与致谢

- DSH 工具注册契约（`output { schema, render }`、标准 JSON-Schema 子集）来自
  `@deepseek-ai/dsh-tools@0.2.1-rc.2`（MIT），仅作为接口约定参考，未复制代码。
- 官方同生态插件 `@anionex/computer-use`（MIT）走的是另一条路线（自带 native helper + `computer_*` 工具），
  README/docs 里只做对比说明，不存在代码来源关系。
