/**
 * 社区、代码与视频渠道：X / GitHub / Reddit / V2EX / B站 / YouTube / RSS / 豆包。
 * 复用已有后端（opencli、twitter-cli、rdt、gh、yt-dlp、bili 直连），只读，不扩大账号权限。
 * 豆包会操作桌面应用，默认不进入自动链，必须显式授权引用。
 */

import { makeEvidence } from "../core/evidence.mjs";
import { redact } from "../core/transport.mjs";
import {
  ghSearch, v2ex, bilibili, youtube, rssRead, social, run, have, doubaoWebSearch,
} from "../legacy.mjs";

const now = () => new Date().toISOString();

function textOutcome(text, provider, actualBackend, kind) {
  const records = extractRecords(String(text || ""), provider, actualBackend, kind);
  return {
    status: records.length ? "ok" : "empty",
    evidence: records,
    warnings: records.length ? [] : ["no_structured_results"],
    usage: { calls: 1, readUrls: 0, credits: null, unit: null, currency: null, amount: null },
  };
}

/** 去掉 markdown/列表前缀与装饰符号，避免标题带 "- " 之类的噪声。 */
function cleanTitleCandidate(value) {
  return String(value ?? "")
    .replace(/^[\s\-*•·>#|\d.)、]+/, "")
    .replace(/[*_`>#|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 从任意 CLI 文本结果里尽力提取 URL + 标题；提不出 URL 就不伪造证据。 */
export function extractRecords(text, provider, actualBackend, kind = "web") {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const urlMatch = lines[i].match(/https?:\/\/[^\s"'<>)]+/);
    if (!urlMatch) continue;
    const url = urlMatch[0];
    const titleCandidates = [
      cleanTitleCandidate(lines[i].replace(urlMatch[0], "")),
      cleanTitleCandidate(lines[i - 1]),
      cleanTitleCandidate(lines[i + 1]),
    ];
    // 中文标题很短也有意义（如"标题"），不能套用英文长度阈值。
    const isUsableTitle = (t) => Boolean(t) && !/^https?:/.test(t)
      && (/[\u4e00-\u9fa5]/.test(t) ? t.length >= 2 : t.length > 3);
    const title = titleCandidates.find(isUsableTitle) || url;
    const context = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 3)).join(" ").slice(0, 600);
    out.push(makeEvidence({
      provider,
      actualBackend,
      url,
      title: title.slice(0, 300),
      excerpt: context,
      excerptType: "snippet",
      kind,
    }));
  }
  const seen = new Set();
  return out.filter((e) => (seen.has(e.canonicalUrl) ? false : (seen.add(e.canonicalUrl), true))).slice(0, 20);
}

function twitterProvider() {
  return {
    id: "x",
    capabilities: ["search"],
    billing: "account",
    async checkAvailability() {
      const ok = (await have("twitter")) || (await have("opencli"));
      return { configured: Boolean(ok), installed: Boolean(ok), verifiedAt: null, health: "unknown", reason: ok ? null : "twitter-cli / opencli 未安装" };
    },
    async probe() {
      return this.checkAvailability();
    },
    async execute(task, ctx) {
      const raw = await social("twitter", "search", task.input.query, ctx?.signal);
      const backend = (await have("twitter")) ? "twitter-cli" : "opencli";
      // 优先解析结构化 JSON；失败再退回文本提取。
      const evidence = extractXFromJson(raw, backend) || extractXRecords(raw, backend);
      return {
        status: evidence.length ? "ok" : "empty",
        evidence,
        warnings: evidence.length ? [] : ["X 返回内容未包含可解析的推文链接"],
        usage: { calls: 1, readUrls: 0, credits: null, unit: null, currency: null, amount: null },
      };
    },
  };
}

function githubProvider() {
  return {
    id: "github",
    capabilities: ["search"],
    billing: "anonymous",
    async checkAvailability() {
      const ok = await have("gh");
      return { configured: Boolean(ok), installed: Boolean(ok), verifiedAt: null, health: "unknown", reason: ok ? null : "gh CLI 未安装：brew install gh" };
    },
    async probe() {
      return this.checkAvailability();
    },
    async execute(task, ctx) {
      const rows = await ghSearch("repos", task.input.query, Math.min(task.input.limit ?? 10, 10), ctx?.signal);
      return textOutcome(rows, "github", "gh repo search", "code");
    },
  };
}

function redditProvider() {
  return {
    id: "reddit",
    capabilities: ["search"],
    billing: "account",
    async checkAvailability() {
      const ok = (await have("opencli")) || (await have("rdt"));
      return { configured: Boolean(ok), installed: Boolean(ok), verifiedAt: null, health: "unknown", reason: ok ? null : "opencli / rdt 未安装" };
    },
    async probe() {
      return this.checkAvailability();
    },
    async execute(task, ctx) {
      const raw = await social("reddit", "search", task.input.query, ctx?.signal);
      return textOutcome(raw, "reddit", (await have("opencli")) ? "opencli" : "rdt", "social");
    },
  };
}

function v2exProvider() {
  return {
    id: "v2ex",
    capabilities: ["search"],
    billing: "anonymous",
    async checkAvailability() {
      return { configured: true, installed: null, verifiedAt: null, health: "unknown", reason: "公开 API 无关键词搜索，仅 hot/node/topic" };
    },
    async probe() {
      return this.checkAvailability();
    },
    async execute() {
      // V2EX 没有公开搜索 API：如实返回空并说明，不伪造结果。
      return {
        status: "empty",
        evidence: [],
        warnings: ["V2EX 无公开关键词搜索 API；已改用 hot/node 浏览或由其他渠道覆盖中文讨论"],
        usage: { calls: 0, readUrls: 0, credits: null, unit: null, currency: null, amount: null },
      };
    },
  };
}

function bilibiliProvider() {
  return {
    id: "bilibili",
    capabilities: ["search"],
    billing: "anonymous",
    async checkAvailability() {
      return { configured: true, installed: null, verifiedAt: null, health: "unknown", reason: "直连 API（不要用 yt-dlp，风控 412）" };
    },
    async probe() {
      return this.checkAvailability();
    },
    async execute(task) {
      const raw = await bilibili("search", task.input.query, 1);
      const outcome = textOutcome(raw, "bilibili", "bilibili direct api", "video");
      if (!outcome.evidence.length && raw) {
        return {
          status: "empty",
          evidence: [],
          warnings: ["B站结果无法解析为链接，未计入证据"],
          usage: { calls: 1, readUrls: 0, credits: null, unit: null, currency: null, amount: null },
        };
      }
      return outcome;
    },
  };
}

function youtubeProvider() {
  return {
    id: "youtube",
    capabilities: ["search"],
    billing: "anonymous",
    async checkAvailability() {
      const ok = await have("yt-dlp");
      return { configured: Boolean(ok), installed: Boolean(ok), verifiedAt: null, health: "unknown", reason: ok ? null : "yt-dlp 未安装" };
    },
    async probe() {
      return this.checkAvailability();
    },
    async execute(task, ctx) {
      const raw = await youtube(task.input.query, undefined, ctx?.signal);
      return textOutcome(raw, "youtube", "yt-dlp search", "video");
    },
  };
}

function rssProvider() {
  return {
    id: "rss",
    capabilities: ["read"],
    billing: "anonymous",
    async checkAvailability() {
      return { configured: true, installed: null, verifiedAt: null, health: "unknown", reason: null };
    },
    async probe() {
      return this.checkAvailability();
    },
    async execute(task, ctx) {
      const url = task.input.urls[0];
      // rssRead 内部先做 SSRF 检查（拒绝私网/本机/元数据地址），并限制重定向与响应大小。
      const raw = await rssRead(url, task.input.limit ?? 10, ctx?.signal);
      return textOutcome(raw, "rss", "rss parse", "web");
    },
  };
}

/**
 * 豆包网页版（www.doubao.com）。走浏览器标签页，后台运行、用完释放标签。
 * 不使用桌面应用、不使用豆包浏览器；因此不再需要"会抢焦点"的授权引用。
 */
function doubaoProvider() {
  return {
    id: "doubao",
    capabilities: ["search"],
    billing: "account",
    async checkAvailability() {
      const ok = await have("opencli");
      return {
        configured: Boolean(ok),
        installed: Boolean(ok),
        verifiedAt: null,
        health: "unknown",
        reason: ok ? "网页版，后台运行不抢焦点；需要浏览器已登录 doubao.com" : "opencli 未安装",
      };
    },
    async probe() {
      return this.checkAvailability();
    },
    async execute() {
      // 浏览器宿主只在主会话可用；MCP 不启动浏览器，交由宿主执行。
      const err = new Error("豆包需由主会话在内置浏览器执行（见 references/browser-ai.md）");
      err.code = "unavailable";
      throw err;
    },
  };
}

/**
 * X/Twitter 搜索结果的文本里同时含 t.co 短链与 x.com 正式链接。
 * 短链指向推文外链而非推文本身，优先取 x.com/twitter.com 的 status 链接。
 */
/**
 * 从 X 的结构化 JSON 提取证据（优先）。opencli 用 -f json 输出，
 * 直接取 text/author/created_at 比从文本里猜标题可靠。
 * 文本格式（twitter-cli 的 yaml）走 extractXRecords 兜底。
 */
function extractXFromJson(raw, actualBackend) {
  let rows = null;
  try {
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed : (parsed.tweets || parsed.data || null);
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  const evidence = [];
  for (const row of rows) {
    const url = row.url || (row.id ? `https://x.com/i/status/${row.id}` : "");
    if (!url) continue;
    // 推文正文才是最该展示的"标题"；没有正文时退回作者或链接。
    const body = String(row.text || "").replace(/https?:\/\/t\.co\/\S+/g, "").replace(/\s+/g, " ").trim();
    const title = body ? body.slice(0, 120) : (row.author ? `@${row.author}` : url);
    const meta = [row.author ? `@${row.author}` : "", row.created_at || "", row.likes != null ? `${row.likes} 赞` : "", row.views ? `${row.views} 浏览` : ""]
      .filter(Boolean).join(" · ");
    evidence.push(makeEvidence({
      provider: "x",
      actualBackend,
      url,
      title,
      excerpt: [body, meta].filter(Boolean).join(" | ").slice(0, 600),
      excerptType: "snippet",
      kind: "social",
      publishedAt: null,
    }));
  }
  return evidence.length ? evidence : null;
}

function extractXRecords(text, actualBackend) {
  const statusUrls = [];
  const seen = new Set();
  for (const match of String(text).matchAll(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^\s"'<>)]*?status\/(\d+)/g)) {
    const url = match[0].replace(/[.,;:、，。；）】]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    statusUrls.push(url);
  }
  if (!statusUrls.length) {
    // 没有正式链接时退回通用提取（短链也如实保留，但不冒充推文链接）。
    return extractRecords(text, "x", actualBackend, "social");
  }
  const lines = String(text).split("\n");
  const evidence = statusUrls.map((url, index) => {
    const id = url.match(/status\/(\d+)/)?.[1] || String(index);
    // 在原文里找到包含该 id 附近的内容作为标题与摘要。
    const lineIndex = lines.findIndex((l) => l.includes(id));
    const author = lineIndex >= 0
      ? (lines.slice(Math.max(0, lineIndex - 6), lineIndex).join(" ").match(/author:\s*([^\s|]+)/)?.[1] || "")
      : "";
    const context = lineIndex >= 0
      ? lines.slice(lineIndex, Math.min(lines.length, lineIndex + 8)).join(" ").replace(/-\s+/g, " ").slice(0, 500)
      : "";
    return makeEvidence({
      provider: "x",
      actualBackend,
      url,
      title: author ? `@${author} 的推文` : `推文 ${id}`,
      excerpt: context,
      excerptType: "snippet",
      kind: "social",
    });
  });
  const deduped = new Set();
  return evidence.filter((e) => (deduped.has(e.canonicalUrl) ? false : (deduped.add(e.canonicalUrl), true))).slice(0, 20);
}

/**
 * 微信公众号文章搜索（搜狗微信）。
 * 走 opencli 的 weixin search（标记 public，免登录）；实测约 3 秒返回。
 * 返回的是搜狗跳转链接，真实地址需打开后解析；正文可用 weixin download 获取。
 */
/**
 * Gemini 网页版（gemini.google.com）。与豆包一样只能由主会话在内置浏览器执行。
 * 编辑器为 Quill（div.ql-editor），提交优先点发送按钮。
 */
function geminiProvider() {
  return {
    id: "gemini",
    capabilities: ["search"],
    billing: "account",
    async checkAvailability() {
      return {
        configured: true,
        installed: null,
        verifiedAt: null,
        health: "unknown",
        reason: "需主会话在内置浏览器执行；需已登录 Google 账号",
      };
    },
    async probe() {
      return this.checkAvailability();
    },
    async execute() {
      const err = new Error("Gemini 需由主会话在内置浏览器执行（见 references/browser-ai.md）");
      err.code = "unavailable";
      throw err;
    },
  };
}

function weixinProvider() {
  return {
    id: "weixin",
    capabilities: ["search"],
    billing: "anonymous",
    async checkAvailability() {
      const ok = await have("opencli");
      return {
        configured: Boolean(ok),
        installed: Boolean(ok),
        verifiedAt: null,
        health: "unknown",
        reason: ok ? "公开搜索（搜狗微信），无需登录" : "opencli 未安装",
      };
    },
    async probe() {
      return this.checkAvailability();
    },
    async execute(task, ctx) {
      const limit = Math.min(Math.max(Number(task.input.limit) || 10, 1), 10);
      // persistent 会话：复用一个后台标签，避免每次搜索开关窗口造成闪烁（与 X 链路一致）。
      const r = await run("opencli", [
        "weixin", "search", task.input.query,
        "--limit", String(limit),
        "--window", "background",
        "--site-session", "persistent",
        "--keep-tab", "true",
        "-f", "json",
      ], 90000, { signal: ctx?.signal });
      if (!r.ok || !r.stdout.trim()) {
        const err = new Error(`微信搜索失败: ${(r.stderr || r.stdout).slice(0, 300)}`);
        err.code = "upstream";
        throw err;
      }
      let rows = [];
      try {
        const parsed = JSON.parse(r.stdout);
        rows = Array.isArray(parsed) ? parsed : [];
      } catch {
        rows = [];
      }
      const evidence = rows
        .filter((row) => row && row.url)
        .map((row) => makeEvidence({
          provider: "weixin",
          actualBackend: "opencli weixin search",
          url: row.url,
          title: row.title || "微信公众号文章",
          excerpt: [row.summary, row.publish_time ? `发布于 ${row.publish_time}` : ""].filter(Boolean).join(" · "),
          excerptType: "snippet",
          kind: "social",
          publishedAt: null,
          // 搜狗跳转链接：真实地址需打开后解析，标注以免误当最终地址。
          warnings: ["sogou_redirect_link"],
        }));
      return {
        status: evidence.length ? "ok" : "empty",
        evidence,
        warnings: evidence.length ? [] : ["微信搜索未返回可解析结果"],
        usage: { calls: 1, readUrls: 0, credits: null, unit: null, currency: null, amount: null },
      };
    },
  };
}

export function createCommunityProviders() {
  return [
    twitterProvider(),
    githubProvider(),
    redditProvider(),
    v2exProvider(),
    bilibiliProvider(),
    youtubeProvider(),
    rssProvider(),
    doubaoProvider(),
    geminiProvider(),
    weixinProvider(),
  ];
}

/** 允许调度层直接调用 gh CLI 读取仓库 README 等公开来源。 */
export async function ghApi(pathname, ctx) {
  const r = await run("gh", ["api", pathname], ctx?.deadline ? Math.max(1000, ctx.deadline - Date.now()) : 20000, { signal: ctx?.signal });
  if (!r.ok) {
    const err = new Error(redact(r.stderr || "gh api 失败"));
    err.code = "unavailable";
    throw err;
  }
  return r.stdout;
}
