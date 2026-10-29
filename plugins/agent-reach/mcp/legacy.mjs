/**
 * Agent Reach legacy channels — zero-dependency Node ESM (Node 18+).
 * 原有的渠道实现集中在此，供旧工具兼容层与新调度层共用。
 * 本模块不在 import 时联网、不自动启动桌面应用、不读取凭据文件；
 * 所有外部后端在调用时探测。
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// 用户提供的 URL 一律先过 SSRF 检查（拒绝私网/本机/元数据地址与 userinfo）。
import { assertSafeUserUrl } from "./core/transport.mjs";

export const MAX_OUT = 60000;
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export function cap(s, n = MAX_OUT) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + `\n...[truncated ${s.length - n} chars]` : s;
}

/**
 * 执行子进程。契约：永远 resolve、不 reject，返回 { ok, stdout, stderr }。
 * 第四个参数可传 { signal }：取消时先 SIGTERM，2 秒后仍未退出再 SIGKILL，
 * 并把 ok 置为 false、在 stderr 追加 "[cancelled]"；不传 signal 时行为与旧版一致。
 */
export function run(bin, args, timeoutMs = 30000, options = {}) {
  // 裸命令名先解析为绝对路径：Windows 需要 .exe/.cmd，且部分宿主不继承完整 PATH。
  const resolved = bin.includes("/") || bin.includes("\\") ? bin : (findExecutable(bin) || bin);
  const signal = options?.signal || null;
  return new Promise((resolve) => {
    let killTimer = null;
    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
      killTimer.unref?.();
    };
    const child = execFile(
      resolved,
      args.map(String),
      { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (killTimer) clearTimeout(killTimer);
        if (signal) signal.removeEventListener("abort", onAbort);
        const cancelled = Boolean(signal?.aborted);
        resolve({
          ok: !err && !cancelled,
          stdout: stdout || "",
          stderr:
            (stderr || "") +
            (cancelled
              ? "\n[cancelled]"
              : err && err.killed
                ? "\n[timed out]"
                : err && err.message
                  ? `\n${err.message}`
                  : ""),
        });
      }
    );
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * 合并外部取消信号与超时（Node 18 无 AbortSignal.any）。
 * 调用方必须在拿到响应体之后调用 cleanup()，否则会中断正文字节流。
 */
function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason ?? new Error("cancelled"));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * 有界读取响应正文：流式读取，超过上限立即中止，避免整体读入内存。
 * 不用 res.text()/arrayBuffer()——它们会把整段响应先落进内存。
 */
async function readTextBounded(res, limitBytes, label) {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await res.text();
    if (Buffer.byteLength(text) > limitBytes) throw new Error(`${label} 响应超过 ${limitBytes} 字节上限`);
    return text;
  }
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limitBytes) throw new Error(`${label} 响应超过 ${limitBytes} 字节上限`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
    try { await body.cancel(); } catch {}
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

const binCache = new Map();

/**
 * 探测后端可执行文件。
 * 不写死 /usr/bin/which：Windows 无此路径，部分 Linux 发行版也位置不同。
 * 用 Node 自带的 PATH 扫描，跨平台且不依赖外部命令。
 */
export async function have(bin) {
  if (binCache.has(bin)) return binCache.get(bin);
  const found = findExecutable(bin);
  binCache.set(bin, found);
  return found;
}

function findExecutable(bin) {
  const isWin = process.platform === "win32";
  const exts = isWin ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  const dirs = (process.env.PATH || "").split(isWin ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext.toLowerCase());
      try {
        const st = statSync(candidate);
        if (st.isFile() && (isWin || (st.mode & 0o111))) return candidate;
      } catch {
        // 不存在或无权限，继续
      }
    }
  }
  return "";
}

/** 测试用：清理二进制探测缓存。 */
export function resetBinCache() {
  binCache.clear();
}

// ---------- channels ----------

// ---- Tavily（中文友好，多 key 轮询）----
const TAVILY_KEYS = (process.env.TAVILY_API_KEYS || "")
  .split(",").map((k) => k.trim()).filter(Boolean);
let tavilyIdx = 0;
const tavilyNextKey = () => TAVILY_KEYS[tavilyIdx++ % TAVILY_KEYS.length];
export const TAVILY_URL = { search: "https://api.tavily.com/search", research: "https://api.tavily.com/research" };

export async function tavilyPost(endpoint, body) {
  if (!TAVILY_KEYS.length) throw new Error("TAVILY_API_KEYS 未配置");
  let lastErr;
  for (let a = 0; a < TAVILY_KEYS.length; a++) {
    const key = tavilyNextKey();
    try {
      const res = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, api_key: key }),
      });
      if (res.ok) return await res.json();
      lastErr = `${res.status}`;
      if (res.status !== 429 && res.status !== 401 && res.status < 500) throw new Error(`tavily ${res.status}`);
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(`tavily 全部 key 失败: ${lastErr}`);
}

export function tavilyFormat(data) {
  const lines = [];
  if (data.answer) lines.push(`答案: ${data.answer}`);
  for (const r of data.results ?? []) lines.push(`\n${r.title}\n${r.url}\n${(r.content || "").slice(0, 600)}`);
  return lines.join("\n") || "(无结果)";
}

export async function tavilySearch(query, numResults, depth) {
  const data = await tavilyPost(TAVILY_URL.search, {
    query, max_results: Math.min(numResults ?? 5, 20),
    search_depth: depth || "basic", include_answer: true,
  });
  return tavilyFormat(data);
}

// ---- 全渠道扇出调研（旧同步接口）：一次调用，多路并行，失败自动降级 ----
// 注意：桌面豆包不再自动加入；需要显式工具调用。V2EX 无公开搜索 API，如实标注。
export async function researchAll(query, numResults, includeSocial) {
  const jobs = [
    ["Tavily(中文网页)", () => tavilySearch(query, numResults)],
    ["Exa(英文/技术)", () => exaSearch(query, numResults, "web")],
    ["GitHub", () => ghSearch("repos", query, Math.min(numResults, 10))],
    ["V2EX(中文社区)", () => v2exQuery(query)],
    ["B站(中文视频)", () => bilibili("search", query)],
    ["YouTube(视频)", () => youtube(query)],
  ];
  if (includeSocial) {
    jobs.push(["Twitter", () => social("twitter", "search", query)]);
    jobs.push(["Reddit", () => social("reddit", "search", query)]);
  }
  const settled = await Promise.allSettled(jobs.map(([, fn]) => fn()));
  const out = [`# 全网调研: ${query}\n`];
  settled.forEach((res, i) => {
    const [label] = jobs[i];
    out.push(`\n## ${label}`);
    if (res.status === "fulfilled" && String(res.value).trim()) out.push(String(res.value).slice(0, 6000));
    else out.push(`(不可用: ${res.status === "rejected" ? String(res.reason?.message || res.reason).slice(0, 200) : "空"})`);
  });
  return out.join("\n");
}

/** V2EX 没有公开搜索 API：如实说明，不伪造结果。 */
export async function v2exQuery(query) {
  return `(V2EX 无公开搜索 API，未执行关键词检索: ${String(query).slice(0, 80)}；可改用 reach_v2ex hot/node 浏览)`;
}

/**
 * 豆包网页版（www.doubao.com，走浏览器标签页）。
 *
 * 使用要求（重要）：
 * - 不用桌面应用、不用豆包浏览器；只通过 opencli 的 doubao 网页适配器。
 * - 默认后台窗口（--window background），不抢用户焦点。
 * - persistent 会话复用一个后台标签（--site-session persistent --keep-tab true），
 *   避免每次调用开关窗口产生可见闪烁；代价是常驻一个后台标签。
 * - 需要 Chrome 已登录 doubao.com；未登录时返回明确提示。
 */
export const DOUBAO_WEB_TIMEOUT_SEC = Number(process.env.AGENT_REACH_DOUBAO_TIMEOUT || 90);

export async function doubaoWebSearch(query, scope = "both", options = {}) {
  if (!(await have("opencli"))) throw new Error("未安装 opencli（豆包网页版需要它作为浏览器桥接）");
  const focus = {
    general: "请联网搜索通用网页信息",
    douyin: "请重点搜索抖音、头条及字节跳动生态内的信息",
    both: "请同时搜索通用网页和抖音、头条及字节跳动生态，并分两部分整理",
  }[scope] || "请联网搜索";
  const prompt = `${focus}。问题：${query}\n请给出关键结论、来源名称和可用链接；无法确认的内容明确标注。`;

  // 先确认登录状态，避免把"未登录"误报成"无结果"。
  const status = await run("opencli", ["doubao", "whoami", "-f", "json"], 30000);
  if (!status.ok || !/"logged_in"\s*:\s*true/.test(status.stdout)) {
    const err = new Error("豆包网页版未登录：请在浏览器打开 doubao.com 完成登录后重试（不会自动操作你的桌面应用）");
    err.code = "auth";
    throw err;
  }

  const args = [
    "doubao", "ask", prompt,
    "--window", options.windowMode || "background",
    "--site-session", "persistent",
    "--keep-tab", "true",
    "--timeout", String(options.timeoutSec || DOUBAO_WEB_TIMEOUT_SEC),
    "-f", "json",
  ];
  const r = await run("opencli", args, (Number(options.timeoutSec || DOUBAO_WEB_TIMEOUT_SEC) + 30) * 1000);
  if (!r.ok || !r.stdout.trim()) {
    const err = new Error(`豆包网页版调用失败: ${(r.stderr || r.stdout).slice(0, 400)}`);
    err.code = "upstream";
    throw err;
  }
  return r.stdout;
}

/**
 * @deprecated 桌面豆包会启动/操作本机应用并抢占焦点，已默认停用。
 * 保留函数名仅为兼容旧调用；请改用 doubaoWebSearch。
 */
export async function doubaoSearch(query, scope = "both") {
  return doubaoWebSearch(query, scope);
}

export async function exaSearch(query, numResults, mode) {
  const tool =
    mode === "code"
      ? `exa.get_code_context_exa(query: ${JSON.stringify(query)}, tokensNum: 3000)`
      : `exa.web_search_exa(query: ${JSON.stringify(query)}, numResults: ${numResults})`;
  // 多 key 轮询：mcporter 中 exa / exa2... 各持一个 key，限流或失败自动切换
  const servers = (process.env.EXA_MCP_SERVERS || "exa,exa2")
    .split(",").map((name) => name.trim()).filter(Boolean);
  let lastErr;
  for (const srv of servers) {
    const r = await run("mcporter", ["call", tool.replace(/^exa\./, `${srv}.`)], 90000);
    const out = (r.stdout || "").trim();
    if (r.ok && out && !/rate limit|429|tool not found|-32602/i.test(out)) return out;
    lastErr = out || r.stderr || "empty response";
  }
  // 代码上下文工具不可用时，退回带代码约束的网页搜索，但必须标明真实来源。
  if (mode === "code") {
    const fallback = await exaSearch(`${query} source code implementation`, numResults, "web").catch((e) => {
      throw new Error(`mcporter exa 全部 key 失败: ${String(e.message).slice(0, 300)}`);
    });
    return `[回退: Exa code 工具不可用，已改用 web 搜索]\n${fallback}`;
  }
  throw new Error(`mcporter exa 全部 key 失败: ${String(lastErr).slice(0, 500)}`);
}

async function readWithJina(url) {
  const timeout = withTimeout(null, 30000);
  try {
    const res = await fetch("https://r.jina.ai/" + url, {
      headers: { "User-Agent": UA },
      signal: timeout.signal,
    });
    if (!res.ok) throw new Error(`r.jina.ai ${res.status}: ${url}`);
    return await res.text();
  } finally {
    timeout.cleanup();
  }
}

// r.jina.ai 一旦失败，10 分钟内不再重试，避免每次读取都先吃一遍 ~5 秒超时。
const JINA_RETRY_AFTER_MS = 10 * 60 * 1000;
let jinaBlockedUntil = 0;

/**
 * DSH 移植补丁：r.jina.ai 在部分网络被 TLS 重置（本机实测 SSL_ERROR_SYSCALL），
 * 而 firecrawl / scrapfly 的 key 已配置且可用。这里补一条回退链：
 * Jina Reader → Firecrawl scrape → Scrapfly scrape。回退只发生在失败后，
 * 成功路径与上游完全一致；账目沿用各 provider 自己的 usage。
 */
async function readWithProviders(url, primaryError) {
  const { loadCredentials } = await import("./core/credentials.mjs");
  const credentials = loadCredentials({});
  const attempts = [];
  for (const [id, loader] of [
    ["firecrawl", () => import("./providers/firecrawl.mjs")],
    ["scrapfly", () => import("./providers/scrapfly.mjs")],
  ]) {
    try {
      const module = await loader();
      const provider = module.createProvider({ credentials });
      const available = typeof provider.checkAvailability === "function"
        ? await provider.checkAvailability({}, null)
        : null;
      if (available && available.configured === false) {
        attempts.push(`${id}: 未配置`);
        continue;
      }
      const outcome = await provider.execute(
        { id: `read-fallback-${id}`, provider: id, operation: "read", input: { urls: [url], freshness: "recent" } },
        {},
        {},
      );
      const body = outcome?.evidence?.[0]?.excerpt;
      if (outcome?.status === "ok" && body) return body;
      attempts.push(`${id}: ${outcome?.error?.code ?? "无正文"}`);
    } catch (error) {
      attempts.push(`${id}: ${error?.code ?? error?.name ?? "error"}`);
    }
  }
  throw new Error(`Jina Reader 不可用（${primaryError?.message ?? "error"}）；回退失败：${attempts.join(" / ")}`);
}

export async function readWeb(url) {
  assertSafeUserUrl(url);
  if (Date.now() < jinaBlockedUntil) {
    return await readWithProviders(url, new Error("r.jina.ai 近期不可达，已跳过"));
  }
  try {
    return await readWithJina(url);
  } catch (primaryError) {
    jinaBlockedUntil = Date.now() + JINA_RETRY_AFTER_MS;
    return await readWithProviders(url, primaryError);
  }
}

export async function ghSearch(action, query, limit, signal) {
  const sub = { repos: ["repos"], code: ["code"], issues: ["issues"] }[action];
  if (!sub) throw new Error(`action 必须是 repos|code|issues，收到: ${action}`);
  const args = ["search", ...sub, query, "--limit", String(limit)];
  if (action === "repos") args.push("--sort", "stars");
  const r = await run("gh", args, 30000, { signal });
  if (!r.ok) throw new Error(`gh: ${(r.stderr || r.stdout).slice(0, 500)}`);
  return r.stdout || "(无结果)";
}

const topicLine = (t) =>
  `[${t.node?.title || "?"}] ${t.title} — ${t.member?.username || "?"} · ${t.replies ?? 0} 回复\n  ${t.url}`;

async function v2api(p) {
  let res;
  try {
    res = await fetch("https://www.v2ex.com/api" + p, {
      headers: { "User-Agent": "agent-reach/1.0" },
    });
  } catch (e) {
    throw new Error(`V2EX 网络不可达（${e.cause?.code || e.message}），该域名需代理才能访问`);
  }
  if (!res.ok) throw new Error(`v2ex ${res.status}`);
  return res.json();
}

export async function v2ex(mode, arg, page) {
  if (mode === "hot") {
    const list = await v2api("/topics/hot.json");
    return list.map(topicLine).join("\n");
  }
  if (mode === "node") {
    if (!arg) throw new Error("node 模式需要 node 参数，如 python/tech/jobs/qna");
    const list = await v2api(`/topics/show.json?node_name=${encodeURIComponent(arg)}&page=${page || 1}`);
    return list.map(topicLine).join("\n");
  }
  if (mode === "topic") {
    const t = (await v2api(`/topics/show.json?id=${arg}`))[0];
    if (!t) throw new Error(`topic ${arg} 不存在`);
    return `${t.title}\n作者: ${t.member?.username} · 节点: ${t.node?.title} · ${t.replies} 回复\n链接: ${t.url}\n\n${String(t.content || "(正文为空或纯链接)").slice(0, 4000)}`;
  }
  if (mode === "replies") {
    const list = await v2api(`/replies/show.json?topic_id=${arg}&page=${page || 1}`);
    if (!Array.isArray(list)) return "(无回复或 API 异常)";
    return list
      .map((r) => `@${r.member?.username}: ${String(r.content || "").replace(/\s+/g, " ").slice(0, 300)}`)
      .join("\n---\n");
  }
  if (mode === "user") {
    const u = await v2api(`/members/show.json?username=${encodeURIComponent(arg)}`);
    return `${u.username} (@${u.username})\n简介: ${u.tagline || "-"}\nV2EX 生成于第 ${u.created} 号\nhttps://v2ex.com/member/${u.username}`;
  }
  throw new Error(`mode 必须是 hot|node|topic|replies|user，收到: ${mode}`);
}

export function cleanVtt(raw) {
  const lines = raw
    .split("\n")
    .filter(
      (l) =>
        l.trim() &&
        !/^(WEBVTT|Kind:|Language:)/.test(l.trim()) &&
        !l.includes("-->") &&
        !/^\d+$/.test(l.trim())
    )
    .map((l) => l.replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);
  const out = [];
  for (const l of lines) if (l !== out[out.length - 1]) out.push(l);
  return out.join("\n");
}

export async function youtube(input, lang, signal) {
  if (!/^https?:\/\//.test(input)) {
    const r = await run("yt-dlp", ["--dump-json", "--flat-playlist", `ytsearch5:${input}`], 90000, { signal });
    if (!r.stdout.trim()) throw new Error(`yt-dlp 搜索失败: ${(r.stderr || "").slice(0, 400)}`);
    const items = r.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          const j = JSON.parse(l);
          return `${j.title}\n  ${j.url}`;
        } catch {
          return l;
        }
      });
    return "YouTube 搜索结果:\n" + items.join("\n");
  }
  const r = await run(
    "yt-dlp",
    [
      "--dump-json", "--write-sub", "--write-auto-sub",
      "--sub-lang", lang || "zh-Hans,zh,en",
      "--skip-download", "-o", join(tmpdir(), "%(id)s"), input,
    ],
    180000,
    { signal }
  );
  if (!r.stdout.trim()) throw new Error(`yt-dlp 失败: ${(r.stderr || "").slice(-800)}`);
  const meta = JSON.parse(r.stdout.trim().split("\n")[0]);
  const tmpDir = tmpdir();
  const files = (await readdir(tmpDir)).filter((f) => f.startsWith(meta.id) && f.endsWith(".vtt"));
  let subs = "";
  for (const f of files) {
    subs += `\n--- ${f} ---\n` + cleanVtt(await readFile(path.join(tmpDir, f), "utf8"));
  }
  const dur = meta.duration ? `${Math.floor(meta.duration / 60)}分${Math.round(meta.duration % 60)}秒` : "?";
  const info = `标题: ${meta.title}\n频道: ${meta.uploader || meta.channel || "?"}\n时长: ${dur}\n播放: ${meta.view_count ?? "?"}\n链接: ${meta.webpage_url || input}`;
  return info + (subs ? `\n\n字幕/转录:\n${subs}` : "\n\n(未找到字幕)");
}

// ---- bilibili（零配置直连 API；不要用 yt-dlp，B站风控 412）----

let biliCookie = null;
async function biliBootstrap() {
  if (biliCookie !== null) return biliCookie;
  try {
    const res = await fetch("https://www.bilibili.com/", { headers: { "User-Agent": UA } });
    const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    biliCookie = sc.map((c) => c.split(";")[0]).join("; ");
  } catch {
    biliCookie = "";
  }
  return biliCookie;
}

async function biliApi(url) {
  const cookie = await biliBootstrap();
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Referer: "https://www.bilibili.com/",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  if (!res.ok) throw new Error(`bilibili HTTP ${res.status}`);
  const j = await res.json();
  if (j.code !== 0) throw new Error(`bilibili api code ${j.code}: ${j.message || ""}`);
  return j.data;
}

export const durFmt = (d) => {
  if (typeof d === "string" && d.trim()) return d.trim();
  if (typeof d === "number" && d)
    return `${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, "0")}`;
  return "?";
};
const stripEm = (s) => String(s || "").replace(/<[^>]+>/g, "");
const bvLine = (v) =>
  `${stripEm(v.title)}\n  UP: ${v.owner?.name || v.author || "?"} · ${v.stat?.view ?? v.play ?? "?"}播放 · ${durFmt(v.duration)} · https://www.bilibili.com/video/${v.bvid}`;

export async function bilibili(mode, arg, page) {
  if (mode === "search") {
    if (!arg) throw new Error("search 需要 keyword 参数");
    const data = await biliApi(
      `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(arg)}&page=${page || 1}`
    );
    const videos = ((data.result || []).find((b) => b.result_type === "video")?.data || []).filter(
      (v) => v.bvid
    );
    return videos.slice(0, 10).map(bvLine).join("\n") || "(无结果)";
  }
  if (mode === "video") {
    const bv = arg?.match(/(BV[0-9A-Za-z]+)/)?.[1];
    if (!bv) throw new Error(`video 需要 BV 号或链接，收到: ${arg}`);
    const v = await biliApi(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
    return `${v.title}\nUP: ${v.owner?.name} · ${durFmt(v.duration)} · ${v.pubdate ? new Date(v.pubdate * 1000).toISOString().slice(0, 10) : ""}\n播放 ${v.stat?.view} · 弹幕 ${v.stat?.danmaku} · 评论 ${v.stat?.reply} · 点赞 ${v.stat?.like}\nhttps://www.bilibili.com/video/${v.bvid}\n\n简介: ${String(v.desc || "-").slice(0, 1500)}`;
  }
  if (mode === "hot") {
    const data = await biliApi("https://api.bilibili.com/x/web-interface/popular");
    return (data.list || []).slice(0, 10).map(bvLine).join("\n");
  }
  throw new Error(`mode 必须是 search|video|hot，收到: ${mode}`);
}

export const RSS_MAX_BYTES = 2 * 1024 * 1024;
export const RSS_TIMEOUT_MS = 30000;

export async function rssRead(url, limit, signal) {
  // 用户传入的 URL：先拒绝私网/本机/元数据地址，再发请求。
  assertSafeUserUrl(url);
  const timeout = withTimeout(signal, RSS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      // 不跟随重定向：避免"公网 302 → 内网地址"绕过 SSRF 检查。
      redirect: "manual",
      signal: timeout.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers?.get?.("location") || "";
      throw new Error(
        `rss 不接受重定向（HTTP ${res.status}${location ? ` → ${location}` : ""}）：请直接使用最终 feed 地址`
      );
    }
    if (!res.ok) throw new Error(`rss ${res.status}: ${url}`);
    const xml = await readTextBounded(res, RSS_MAX_BYTES, "rss");
    const items = [...xml.matchAll(/<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/g)].slice(0, limit);
    if (!items.length) return "(未解析到条目，可能不是 RSS/Atom)";
    const strip = (s) =>
      String(s || "")
        .replace(/<!\[CDATA\[|\]\]>/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    const pick = (s, tag) => {
      const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? strip(m[1]) : "";
    };
    const linkOf = (s) => pick(s, "link") || s.match(/<link[^>]*href="([^"]+)"/i)?.[1] || "";
    return items
      .map(({ 0: it }, i) => {
        const title = pick(it, "title");
        const date = pick(it, "pubDate") || pick(it, "updated") || pick(it, "published");
        const desc = pick(it, "description") || pick(it, "summary");
        return `${i + 1}. ${title}${date ? ` (${date.slice(0, 25)})` : ""}\n   ${linkOf(it)}${desc ? `\n   ${desc.slice(0, 200)}` : ""}`;
      })
      .join("\n");
  } finally {
    timeout.cleanup();
  }
}

export const SOCIAL_HINTS = {
  twitter:
    "twitter-cli 未安装: pipx install twitter-cli (v0.8.5+)，用 Cookie-Editor 导出后设置 TWITTER_AUTH_TOKEN + TWITTER_CT0；或装 OpenCLI 桌面端走浏览器登录态。",
  reddit:
    "Reddit 后端未安装。桌面方案 OpenCLI（浏览器登录态）；服务器方案: pipx install 'git+https://github.com/public-clis/rdt-cli.git' 然后 rdt login。",
};

export async function social(platform, action, query, signal) {
  if (platform === "twitter") {
    // 顺序：先用 opencli；twitter-cli 作为回退（不重试，实测它 404 时会拖慢到 90s+）。
    // 会话模式 persistent + keep-tab true：opencli 经浏览器扩展桥接用户 Chrome，
    // 一次性标签每次搜索都要开/关窗口产生可见闪烁；persistent 保留一个后台站点
    // 标签反复复用（实测复用时约 3.5s，不再闪烁）。代价：Chrome 常驻一个后台
    // 标签；需要释放时在浏览器里手动关闭该标签即可。
    if (await have("opencli")) {
      const r = await run("opencli", [
        "twitter", action || "search", query,
        "--limit", "15",
        "--window", "background",
        "--site-session", "persistent",
        "--keep-tab", "true",
        "-f", "json",
      ], 60000, { signal });
      if (r.ok && r.stdout.trim() && !/^\s*\[\s*\]\s*$/.test(r.stdout)) return r.stdout;
    }
    if (await have("twitter")) {
      const map = { search: ["search", query, "-n", "10"], feed: ["feed", "-n", "20"], tweet: ["tweet", query], user: ["user", query], user_posts: ["user-posts", query, "-n", "20"], article: ["article", query] };
      const r = await run("twitter", (map[action] || map.search).filter((a) => a !== undefined && a !== ""), 30000, { signal });
      if (r.ok && r.stdout.trim()) return r.stdout;
    }
    throw new Error(SOCIAL_HINTS.twitter);
  }
  if (platform === "reddit") {
    if (await have("opencli")) {
      const map = { search: ["search", query], read: ["read", query], subreddit: ["subreddit", query], hot: ["hot"], popular: ["popular"] };
      // 与 X 链路一致：后台窗口 + persistent 会话复用标签，避免反复开关窗口。
      const r = await run("opencli", ["reddit", ...(map[action] || map.search).filter(Boolean), "--window", "background", "--site-session", "persistent", "--keep-tab", "true", "-f", "yaml"], 90000, { signal });
      if (r.ok && r.stdout.trim()) return r.stdout;
    }
    if (await have("rdt")) {
      const map = { search: ["search", query, "--limit", "10"], read: ["read", query], subreddit: ["sub", query, "--limit", "20"], hot: ["popular", "--limit", "10"], popular: ["popular", "--limit", "10"] };
      const r = await run("rdt", (map[action] || map.search).filter(Boolean), 60000, { signal });
      if (r.ok && r.stdout.trim()) return r.stdout;
    }
    throw new Error(SOCIAL_HINTS.reddit);
  }
  throw new Error(`未知平台: ${platform}（支持 twitter/reddit）`);
}

export async function status() {
  const bins = ["mcporter", "gh", "yt-dlp", "bili", "twitter", "rdt", "opencli", "ffmpeg"];
  const lines = ["== 后端二进制 =="];
  for (const b of bins) lines.push(`  ${b.padEnd(9)} ${(await have(b)) ? "✅" : "❌ 未安装"}`);
  lines.push("", "== 平台 → 路由 ==");
  const route = async (name, primary, ok, fallback) =>
    lines.push(`  ${name.padEnd(12)} ${ok ? "✅ " + primary : "❌ " + fallback}`);
  await route("搜索(Exa)", "mcporter exa（零配置）", await have("mcporter"), "安装 mcporter");
  await route("网页阅读", "r.jina.ai（零配置）", true, "-");
  await route("GitHub", "gh CLI", await have("gh"), "brew install gh");
  await route("V2EX", "公开 API（零配置，无搜索）", true, "-");
  await route("YouTube", "yt-dlp", await have("yt-dlp"), "brew install yt-dlp");
  await route("B站", "直连 API（零配置）/ bili-cli", true, "-");
  await route("RSS", "内置解析（零配置）", true, "-");
  await route("Twitter", "twitter-cli / opencli", (await have("twitter")) || (await have("opencli")), SOCIAL_HINTS.twitter);
  await route("Reddit", "opencli / rdt", (await have("opencli")) || (await have("rdt")), SOCIAL_HINTS.reddit);
  await route("豆包/抖音生态", "桌面豆包(opencli，显式调用)", await have("opencli"), "安装并登录桌面豆包 + opencli");
  return lines.join("\n");
}

// ---------- 旧工具表（保持名称与参数 schema 不变） ----------

export const legacyTools = [
  {
    name: "reach_search",
    description: "Exa AI 全网搜索（零配置，擅长英文/技术/代码内容）。mode=code 时做代码上下文搜索。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        num_results: { type: "number", default: 5, maximum: 20 },
        mode: { type: "string", enum: ["web", "code"], default: "web" },
      },
      required: ["query"],
    },
  },
  {
    name: "reach_read",
    description: "读取任意网页/文章正文，返回 Markdown（Jina Reader，零配置）。适用公众号、博客、新闻、推文等任意 URL。",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "reach_github",
    description: "GitHub 搜索（gh CLI）。action: repos=仓库(按star排序) / code=代码 / issues=Issue。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["repos", "code", "issues"], default: "repos" },
        query: { type: "string" },
        limit: { type: "number", default: 10, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "reach_v2ex",
    description: "V2EX 社区（零配置公开 API）。mode: hot=热门 / node=节点帖子 / topic=帖子详情 / replies=回复 / user=用户。",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["hot", "node", "topic", "replies", "user"], default: "hot" },
        arg: { type: "string", description: "node 名称 / topic_id / username，hot 模式不需要" },
        page: { type: "number", default: 1 },
      },
    },
  },
  {
    name: "reach_youtube",
    description: "YouTube：传 URL 返回视频信息+字幕转录文本；传普通关键词则搜索视频（yt-dlp，零配置）。",
    inputSchema: {
      type: "object",
      properties: {
        url_or_query: { type: "string" },
        sub_lang: { type: "string", default: "zh-Hans,zh,en" },
      },
      required: ["url_or_query"],
    },
  },
  {
    name: "reach_bilibili",
    description: "B站（零配置直连 API）。mode: search=搜索 / video=视频详情(传BV号或链接) / hot=热门。不要对B站用 yt-dlp（风控412）。",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["search", "video", "hot"], default: "search" },
        keyword_or_bv: { type: "string" },
        page: { type: "number", default: 1 },
      },
    },
  },
  {
    name: "reach_rss",
    description: "读取 RSS/Atom 订阅源，列出最新条目标题+链接+摘要（零配置）。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, limit: { type: "number", default: 10, maximum: 50 } },
      required: ["url"],
    },
  },
  {
    name: "reach_social",
    description: "需登录态社交平台：Twitter/Reddit。按后端可用性自动路由（opencli/twitter-cli/rdt），后端未安装时返回安装指引。action 因平台而异：search/feed/note/tweet/user/hot 等。",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["twitter", "reddit"] },
        action: { type: "string", description: "默认 search；twitter 另有 feed/tweet/user/user_posts/article；reddit 另有 read/subreddit/hot" },
        query: { type: "string", description: "搜索词 / 推文URL / 用户名 / 帖子ID" },
      },
      required: ["platform"],
    },
  },
  {
    name: "reach_tavily",
    description: "Tavily 网页搜索（中文友好、国内可用，多 key 轮询零配置）。depth: basic/advanced。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        num_results: { type: "number", default: 5, maximum: 20 },
        depth: { type: "string", enum: ["basic", "advanced"], default: "basic" },
      },
      required: ["query"],
    },
  },
  {
    name: "reach_doubao",
    description: "豆包网页版中文联网搜索（www.doubao.com）。后台运行、不抢焦点、用完释放浏览器标签；不用桌面应用。scope=general 通用网页，douyin 抖音/头条/字节生态，both 两者并行覆盖。需要浏览器已登录 doubao.com。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string", enum: ["general", "douyin", "both"], default: "both" },
      },
      required: ["query"],
    },
  },
  {
    name: "reach_research",
    description: "全渠道扇出调研：一次调用并行查询 Tavily/Exa/GitHub/V2EX/B站/YouTube（可选 Twitter/Reddit），失败自动降级并汇总。桌面豆包需改用 reach_doubao。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        num_results: { type: "number", default: 5, maximum: 20 },
        include_social: { type: "boolean", default: true, description: "是否纳入需登录态的 Twitter/Reddit" },
      },
      required: ["query"],
    },
  },
  {
    name: "reach_parallel",
    description: "Parallel Search MCP（匿名免 key，返回带摘要的网页结果）。用于免费优先的基础检索。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        num_results: { type: "number", default: 5, maximum: 20 },
      },
      required: ["query"],
    },
  },
];

export async function callLegacyTool(name, args = {}) {
  const { parallelSearch } = await import("./providers/parallel.mjs");
  switch (name) {
    case "reach_search":
      return await exaSearch(args.query, args.num_results ?? 5, args.mode);
    case "reach_read":
      return await readWeb(args.url);
    case "reach_github":
      return await ghSearch(args.action || "repos", args.query, args.limit ?? 10);
    case "reach_v2ex":
      return await v2ex(args.mode || "hot", args.arg, args.page);
    case "reach_youtube":
      return await youtube(args.url_or_query, args.sub_lang);
    case "reach_bilibili":
      return await bilibili(args.mode || "search", args.keyword_or_bv, args.page);
    case "reach_rss":
      return await rssRead(args.url, args.limit ?? 10);
    case "reach_social":
      return await social(args.platform, args.action, args.query);
    case "reach_tavily":
      return await tavilySearch(args.query, args.num_results ?? 5, args.depth);
    case "reach_doubao":
      return await doubaoSearch(args.query, args.scope || "both");
    case "reach_research":
      return await researchAll(args.query, args.num_results ?? 5, args.include_social ?? true);
    case "reach_status":
      // 由入口的可信体检实现处理；此处仅保留兼容调用路径。
      return await status();
    case "reach_parallel": {
      const out = await parallelSearch(args.query, args.num_results ?? 5);
      return out.text;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
