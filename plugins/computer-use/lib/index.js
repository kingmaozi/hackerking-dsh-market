/**
 * computer-use — 把 macOS 的截屏 / 点击 / 输入 / 滚动 / 拖拽注册成 DSH 工具（cua_*）。
 *
 * 挂载方式（profile 的 package.json）：
 *   "computer-use": "link:/Users/zhangsugang/Documents/hackerking/plugins/computer-use"
 * 并把 "computer-use" 加进 dsh.profile.bundles；patch 由本包的 cordis.patch.yml 提供。
 */
import { createComputerUse, createTools, TOOL_NAMES, VERSION, normalizeConfig, parameterSpecOf } from './tools.js';

export const name = 'computer-use';
export const inject = [];

/**
 * 注册 `cua_*` 工具。任何一步失败都只跳过对应能力，不让整个 profile 起不来。
 * @param {any} ctx cordis 插件上下文
 * @param {object} [config] 插件配置（见 normalizeConfig）
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config);
  if (!settings.enabled) {
    ctx.logger?.info?.('[computer-use] config.enabled=false，跳过注册');
    return;
  }
  if (process.platform !== 'darwin') {
    ctx.logger?.warn?.(`[computer-use] 只支持 macOS，当前 ${process.platform}，跳过注册`);
    return;
  }
  const tools = ctx.get?.('tools') ?? ctx.tools;
  if (tools === undefined || typeof tools.register !== 'function') {
    ctx.logger?.warn?.('[computer-use] tools 服务不可用，跳过注册');
    return;
  }

  const state = createComputerUse(ctx, config);
  const definitions = createTools(state);
  let registered = 0;
  for (const definition of definitions) {
    try {
      ctx.effect(() => tools.register(definition));
      registered += 1;
    } catch (error) {
      ctx.logger?.warn?.(`[computer-use] 注册 ${definition.name} 失败（其余工具继续）：${error?.message ?? error}`);
    }
  }
  ctx.logger?.info?.(`[computer-use] ${VERSION} 注册 ${registered} 个工具：${TOOL_NAMES.join(', ')}`);
  ctx.logger?.info?.(`[computer-use] 截图目录 ${settings.captureDir}；内联图片 ${settings.inlineImages ? 'on' : 'off'}；`
    + `权限闸门 ${settings.skipPermissionGate ? 'off' : 'on'}`);
}

export default { name, inject, apply };
export { createComputerUse, createTools, TOOL_NAMES, VERSION, normalizeConfig, parameterSpecOf };
