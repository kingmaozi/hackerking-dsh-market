/**
 * ZCode 私有市场兼容层：保留 2.2.2 的浏览器任务接口，不在 MCP 内执行浏览器。
 * 仅生成交接对象；小红书输入保留兼容，但 3.3.0 已移除对应能力。
 *
 * DSH 移植：上游把任务交接给 ZCode 的 Browser Use（`browser-use:control-browser`
 * + `mcp__node_repl__js` + `agent.browsers.get('iab')`），这两个东西在 DSH 里都不存在。
 * 交接对象改成 DSH 里真实可用的两条路：`browser-automation`（Playwright）或
 * `computer-use` 的 `cua_*` 工具（操作已登录的可见浏览器窗口）。
 */

const HOST_BROWSER_SKILL = "browser-automation";
const HOST_BROWSER_NOTICE =
  "这不是搜索结果。主会话须复用用户已登录的浏览器完成任务：优先加载 browser-automation 技能（Playwright）打开任务 url，"
  + "提取 DOM 正文与外链；没有 Playwright 环境时用 computer-use 的 cua_* 工具操作可见窗口。"
  + "最多两个站点并行、同站间隔 ≥15 秒，遇验证码/未登录立即停止并报告阻塞，完成后关闭本次任务标签。"
  + "不要读取 Cookie/localStorage，不另起干净会话，不把浏览器源结论混进 reach_* 渠道证据。";

export const legacySocialInputSchema = {
  type: "object",
  properties: {
    platform: { type: "string", enum: ["xhs", "twitter", "reddit"] },
    action: { type: "string", description: "默认 search；xhs 另有 note/comments/feed/user；twitter 另有 feed/tweet/user/user_posts/article；reddit 另有 read/subreddit/hot" },
    query: { type: "string", description: "搜索词 / 笔记URL / 推文URL / 用户名 / 帖子ID" },
  },
  required: ["platform"],
};

export const zcodeCompatTools = [
  {
    name: "reach_gemini",
    description: "Gemini 国际/通用联网搜索交接：要求可点击来源链接，主会话用 browser-automation（Playwright）或 cua_* 在已登录浏览器执行并提取 DOM 结果，完成后关闭任务标签。不是搜索结果。",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "reach_browser_plan",
    description: "快速多源浏览器搜索计划，不运行 API 扇出。sources 选 doubao/wechat/twitter/gemini，默认豆包+Gemini；主会话最多两个站点并行、同站限频、提取结果后关闭任务标签。不是已执行结果。",
    inputSchema: { type: "object", properties: { query: { type: "string" }, sources: { type: "array", items: { type: "string", enum: ["doubao", "wechat", "twitter", "gemini"] }, minItems: 1, maxItems: 4 } }, required: ["query"] },
  },
  {
    name: "reach_wechat",
    description: "搜狗微信公众号搜索交接。主会话加载 browser-automation（Playwright）或 cua_*，在已登录浏览器打开 weixin.sogou.com 检索；默认一轮最多五篇，遇验证码停止，完成后关闭本次搜索标签。不是搜索结果。",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

function browserTask(platform, query, url, task) {
  if (typeof query !== "string" || !query.trim()) throw new Error("query 必须是非空字符串");
  return {
    status: "browser_action_required",
    backend: "iab",
    skill: HOST_BROWSER_SKILL,
    platform,
    action: "search",
    policy: { max_rounds: 2, max_results: 5, same_site_interval_seconds: 15, same_site_serial: true, max_parallel_sources: 2, max_task_tabs: 2, max_wait_seconds: 120, stop_on_captcha: true, close_task_tabs: true },
    query,
    url,
    task,
    extraction: "首次 DOM 快照确认结果容器，随后定向 locator.evaluate 提取正文与来源 URL；不重复整页快照，不读取隐藏状态或 Cookie。",
    cleanup: "结果或阻塞记录完成后由主会话显式关闭标签并复查标签列表；MCP 不具有浏览器关闭能力，close_task_tabs 是执行约定。",
    notice: HOST_BROWSER_NOTICE,
  };
}

function geminiSearch(query) {
  return browserTask("gemini", query, "https://gemini.google.com/",
    `请实际联网搜索：${query}。优先国际及官方来源，用中文简短回答并提供至少两个可点击的来源链接，标明来源名称与日期（可得时）。区分实时搜索依据与模型知识；无法联网或未检索到则明确说明。不要生成文件、图片或启动深度研究。`);
}

function wechatSearch(query) {
  return browserTask("wechat", query, `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(query)}&ie=utf8`,
    `直接打开任务 url 的搜狗微信搜索结果，不走首页或输入框。公众号文章查询：${query}。记录标题、公众号、日期、来源链接；摘要与已打开全文分开标注。出现验证码停止，不刷新或绕过。`);
}

function twitterSearch(query) {
  return browserTask("twitter", query, `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query`,
    `直接打开任务 url 的 X 搜索结果，不走首页或输入框。查询：${query}。先复用已有 X/Twitter tab，按实际页面判断登录态；记录相关推文正文、作者、时间及原文链接，只汇报实际读取的内容。不得读取或导出 cookie；遇登录/验证码时明确报告阻塞。`);
}

function doubaoSearch(query, scope = "both") {
  const focus = {
    general: "请使用豆包内置搜索源联网检索，整理结论及来源。",
    douyin: "请使用豆包内置搜索源（包含抖音来源）检索此问题，不要打开抖音站点或单独执行抖音站内搜索。",
    both: "请使用豆包内置搜索源（通用网页及抖音来源）一次检索此问题，由内置搜索自动选择相关来源；不要打开抖音站点，不要另建抖音搜索任务。",
  };
  if (typeof scope !== "string" || !Object.hasOwn(focus, scope)) throw new Error(`scope 必须是 general|douyin|both，收到: ${scope}`);
  return {
    ...browserTask("doubao", query, "https://www.doubao.com/chat/",
      `${focus[scope]}问题：${query}\n请给出关键结论、来源名称和可用链接；无法确认的内容明确标注。区分豆包生成的概述与实际打开验证的来源，不得将豆包概述声称为抖音原文。`),
    scope,
  };
}

function browserPlan(query, sources = ["doubao", "gemini"]) {
  const routes = { doubao: doubaoSearch, wechat: wechatSearch, twitter: twitterSearch, gemini: geminiSearch };
  if (!Array.isArray(sources) || !sources.length || sources.length > 4 || sources.some((source) => typeof source !== "string" || !Object.hasOwn(routes, source))) {
    throw new Error("sources 必须是 doubao|wechat|twitter|gemini 组成的 1–4 项数组");
  }
  return {
    status: "browser_action_required",
    query,
    browser_tasks: [...new Set(sources)].map((source) => routes[source](query)),
    max_parallel_sources: 2,
    notice: "仅生成浏览器执行计划，不调用外部搜索 API。主会话按站点分批并行执行，结果提取后关闭任务标签；不可把计划当结果。",
  };
}

const jsonText = (value, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

/** 返回 null 时由新版入口继续分发，不代理任何网络或浏览器执行。 */
export function callZcodeCompat(name, args = {}) {
  if (name === "reach_gemini") return jsonText(geminiSearch(args.query));
  if (name === "reach_wechat") return jsonText(wechatSearch(args.query));
  if (name === "reach_browser_plan") return jsonText(browserPlan(args.query, args.sources));
  if (name === "reach_doubao") return jsonText(doubaoSearch(args.query, args.scope));
  if (name === "reach_social" && args.platform === "twitter" && (!args.action || args.action === "search")) {
    return jsonText(twitterSearch(args.query));
  }
  if (name === "reach_social" && (args.platform === "xhs" || args.platform === "xiaohongshu")) {
    return jsonText({
      status: "unsupported",
      code: "capability_removed",
      platform: args.platform,
      message: "3.3.0 已移除小红书能力；请改用小红书专门渠道或 skill。本工具未调用任何后端。",
    }, true);
  }
  return null;
}
