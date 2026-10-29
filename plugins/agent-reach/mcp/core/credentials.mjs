/**
 * 凭据读取：只从本机用户目录与环境变量取；不在源码、夹具或日志保存密钥。
 * 返回值仅供内部使用；对外只暴露 credentialStatus。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SECRET_DIR = join(homedir(), ".agent-reach", "briking");
export const PROVIDERS_FILE = join(SECRET_DIR, "providers.json");

const PROVIDER_ENV_KEYS = {
  tavily: ["TAVILY_API_KEYS", "TAVILY_API_KEY"],
  exa: ["EXA_MCP_SERVERS"],
  jina: ["JINA_API_KEY"],
  tinyfish: ["TINYFISH_API_KEY"],
  firecrawl: ["FIRECRAWL_API_KEY"],
  valyu: ["VALYU_API_KEY"],
  scrapfly: ["SCRAPFLY_API_KEY"],
  x: ["TWITTER_AUTH_TOKEN", "TWITTER_CT0"],
  reddit: [],
};

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((v) => v.trim()).filter(Boolean);
  return [];
}

/**
 * 加载凭据：显式环境变量 > providers.json > 既有 keys.env/social.env。
 * 空值不覆盖已有有效配置。
 */
export function loadCredentials({ home = homedir(), env = process.env, secretDir } = {}) {
  const dir = secretDir || join(home, ".agent-reach", "briking");
  const keysEnv = parseEnvFile(join(dir, "keys.env"));
  const socialEnv = parseEnvFile(join(dir, "social.env"));
  let providersFile = {};
  const providersPath = join(dir, "providers.json");
  if (existsSync(providersPath)) {
    try {
      const parsed = JSON.parse(readFileSync(providersPath, "utf8"));
      providersFile = parsed?.api_keys && typeof parsed.api_keys === "object" ? parsed.api_keys : parsed || {};
    } catch {
      providersFile = {};
    }
  }

  const pick = (names) => {
    for (const name of names) {
      if (env[name] !== undefined && String(env[name]).trim() !== "") return String(env[name]);
    }
    return undefined;
  };

  const fromFile = (provider, names) => {
    const direct = providersFile[provider];
    if (direct !== undefined) return asArray(direct);
    for (const name of names) {
      const value = env[name] !== undefined && String(env[name]).trim() !== "" ? env[name] : keysEnv[name] ?? socialEnv[name];
      if (value !== undefined && String(value).trim() !== "") return asArray(value);
    }
    return [];
  };

  const tavilyKeys = pick(["TAVILY_API_KEYS"]) !== undefined
    ? asArray(pick(["TAVILY_API_KEYS"]))
    : fromFile("tavily", ["TAVILY_API_KEYS", "TAVILY_API_KEY"]);
  const exaServers = asArray(
    pick(["EXA_MCP_SERVERS"]) ?? keysEnv.EXA_MCP_SERVERS ?? providersFile.exa_servers ?? "exa,exa2"
  );
  const single = (provider, names) => {
    const value = pick(names);
    if (value !== undefined) return value;
    const arr = fromFile(provider, names);
    return arr[0] ?? "";
  };

  return {
    dir,
    tavily: tavilyKeys,
    exaServers: exaServers.length ? exaServers : ["exa"],
    jina: single("jina", ["JINA_API_KEY"]),
    tinyfish: single("tinyfish", ["TINYFISH_API_KEY"]),
    firecrawl: single("firecrawl", ["FIRECRAWL_API_KEY"]),
    valyu: single("valyu", ["VALYU_API_KEY"]),
    scrapfly: single("scrapfly", ["SCRAPFLY_API_KEY"]),
    twitter: {
      authToken: pick(["TWITTER_AUTH_TOKEN"]) ?? socialEnv.TWITTER_AUTH_TOKEN ?? "",
      ct0: pick(["TWITTER_CT0"]) ?? socialEnv.TWITTER_CT0 ?? "",
    },
    reddit: Boolean(providersFile.reddit) || Boolean(env.REDDIT_CREDENTIALS),
  };
}

/**
 * 缓存账号分区的凭据标识：返回值只传给 accountScope 做哈希，不记录、不输出。
 * 多 key 渠道取第一个 key 作分区标识（同一批 key 视为同一账号）。
 */
export function credentialHint(credentials, providerId) {
  if (!credentials) return "";
  switch (providerId) {
    case "tavily": return credentials.tavily?.[0] || "";
    case "exa": return (credentials.exaServers || []).join(",");
    case "jina":
    case "jina_search":
    case "jina_read": return credentials.jina || "";
    case "tinyfish":
    case "tinyfish_research": return credentials.tinyfish || "";
    case "firecrawl": return credentials.firecrawl || "";
    case "valyu":
    case "valyu_research": return credentials.valyu || "";
    case "scrapfly": return credentials.scrapfly || "";
    case "x": return credentials.twitter?.authToken || "";
    default: return "";
  }
}

/** 对外只暴露"是否配置"，永不返回值本身。 */
export function credentialStatus(credentials) {
  const status = {};
  const set = (id, configured, reason = null) => { status[id] = { configured, reason }; };
  set("tavily", credentials.tavily.length > 0, credentials.tavily.length ? `${credentials.tavily.length} 个 key` : "未配置 TAVILY_API_KEYS");
  set("exa", credentials.exaServers.length > 0, `${credentials.exaServers.length} 个 mcporter 实例`);
  set("jina", Boolean(credentials.jina), credentials.jina ? "已配置 Jina key（Search 有速率上限）" : "未配置 JINA_API_KEY（Jina Search 不可用；Reader 仍可匿名）");
  set("tinyfish", Boolean(credentials.tinyfish), credentials.tinyfish ? "已配置（Search/Fetch 免费，Research 需钱包）" : "未配置 TINYFISH_API_KEY");
  set("firecrawl", Boolean(credentials.firecrawl), credentials.firecrawl ? "已配置" : "未配置 FIRECRAWL_API_KEY");
  set("valyu", Boolean(credentials.valyu), credentials.valyu ? "已配置（专业库与 DeepResearch 另计费）" : "未配置 VALYU_API_KEY");
  set("scrapfly", Boolean(credentials.scrapfly), credentials.scrapfly ? "已配置" : "未配置 SCRAPFLY_API_KEY");
  set("x", Boolean(credentials.twitter.authToken && credentials.twitter.ct0), "twitter-cli 登录态或 opencli");
  set("parallel", true, "匿名免 key");
  set("jina_read", true, "Reader 可匿名（有 key 速率更高）");
  // 无需凭据、依赖本机 CLI 或浏览器登录态的渠道单独标注，避免被误报为"未配置"。
  set("weixin", true, "搜狗微信公开搜索（需 opencli）");
  set("doubao", true, "内置浏览器执行（需登录 doubao.com）");
  set("gemini", true, "内置浏览器执行（需登录 Google 账号）");
  return status;
}

export function providerEnvKeys(id) {
  return PROVIDER_ENV_KEYS[id] || [];
}
