#!/usr/bin/env node

/**
 * 凭据导入器：v1/v2 schema 增量合并，不覆盖已有配置。
 * --check 只报告将修改的路径与数量，不写入任何文件。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const usage = "Usage: node import-credentials.mjs <credentials.json> [--check]";
const file = process.argv[2];
const checkOnly = process.argv.includes("--check");
if (!file || file.startsWith("--")) {
  console.error(usage);
  process.exit(2);
}

const SUPPORTED_SCHEMAS = ["briking-agent-reach-credentials/v1", "briking-agent-reach-credentials/v2"];
const MULTI_KEY_PROVIDERS = ["tavily", "exa"];
const SINGLE_KEY_PROVIDERS = ["jina", "tinyfish", "firecrawl", "valyu", "scrapfly"];
const KNOWN_PROVIDERS = [...MULTI_KEY_PROVIDERS, ...SINGLE_KEY_PROVIDERS];

const home = process.env.HOME || homedir();
const mcpDir = process.env.BRIKING_PLUGIN_MCP_DIR || join(home, ".agent-reach", "briking");
const data = JSON.parse(readFileSync(file, "utf8"));

if (!SUPPORTED_SCHEMAS.includes(data.schema)) {
  console.error(`Unsupported credentials schema: ${String(data.schema)}；支持 ${SUPPORTED_SCHEMAS.join(" 或 ")}`);
  process.exit(2);
}

// 只报告字段名，不回显任何值。
const provided = {};
for (const provider of KNOWN_PROVIDERS) {
  const raw = data.api_keys?.[provider];
  if (raw === undefined) continue;
  const list = Array.isArray(raw) ? raw : [raw];
  const cleaned = list.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
  if (cleaned.length === 0) {
    console.warn(`提示: api_keys.${provider} 为空数组，跳过（不会清除已有配置）`);
    continue;
  }
  for (const [index, value] of cleaned.entries()) {
    if (typeof value !== "string" || !value.trim()) {
      console.error(`字段 api_keys.${provider}[${index}] 不是有效字符串`);
      process.exit(2);
    }
  }
  provided[provider] = cleaned;
}

const twitter = data.twitter
  ? {
    authToken: requiredString(data.twitter.auth_token, "twitter.auth_token"),
    ct0: requiredString(data.twitter.ct0, "twitter.ct0"),
  }
  : null;

// 小红书渠道已彻底移除：旧凭据文件里的 xiaohongshu 字段不再写入任何目标，只提示一次。
if (data.xiaohongshu !== undefined) {
  console.warn("提示: 小红书(xiaohongshu)渠道已移除，该字段被忽略，不会写入任何文件。");
}

const mode = statSync(file).mode & 0o777;
if (mode & 0o077) {
  console.warn(`Warning: 源文件权限为 ${mode.toString(8)}；建议先 chmod 600。`);
}

const newSingleKeys = Object.fromEntries(
  Object.entries(provided).filter(([provider]) => SINGLE_KEY_PROVIDERS.includes(provider)).map(([p, v]) => [p, v[0]])
);
const newMultiKeys = Object.fromEntries(
  Object.entries(provided).filter(([provider]) => MULTI_KEY_PROVIDERS.includes(provider))
);

const targets = [];
if (Object.keys(newSingleKeys).length) targets.push(join(mcpDir, "providers.json"));
if (Object.keys(newMultiKeys).length) targets.push(join(mcpDir, "keys.env"));
if (twitter) targets.push(join(mcpDir, "social.env"));
if (Object.keys(newMultiKeys.exa ? { exa: 1 } : {}).length) targets.push(join(home, ".mcporter", "mcporter.json"));
if (data.reddit) targets.push(join(home, ".config", "rdt-cli", "credential.json"));

if (checkOnly) {
  console.log(JSON.stringify({
    schema: data.schema,
    sourcePermissions: mode.toString(8),
    willModify: targets,
    counts: {
      tavily: provided.tavily?.length ?? 0,
      exa: provided.exa?.length ?? 0,
      singleKeys: Object.keys(newSingleKeys),
      twitter: Boolean(twitter),
      reddit: Boolean(data.reddit),
    },
    note: "仅为预检，未写入任何文件；未列出的 provider 将保留原值。",
    valid: true,
  }, null, 2));
  process.exit(0);
}

// --- 实际写入：全部为增量合并 ---

// 1) 多 key：合并进 keys.env，保留原有其他条目。
if (Object.keys(newMultiKeys).length) {
  const envPath = join(mcpDir, "keys.env");
  const existing = readEnvFile(envPath);
  if (newMultiKeys.tavily) {
    const merged = mergeKeyList(existing.TAVILY_API_KEYS, newMultiKeys.tavily);
    existing.TAVILY_API_KEYS = merged.join(",");
  }
  if (newMultiKeys.exa) {
    const names = newMultiKeys.exa.map((_, i) => (i === 0 ? "exa" : `exa${i + 1}`));
    const mergedNames = mergeKeyList(existing.EXA_MCP_SERVERS, names);
    existing.EXA_MCP_SERVERS = mergedNames.join(",");
  }
  writeSecret(envPath, toEnvFile(existing));
}

// 2) 单 key：写入 providers.json，保留原有其他 provider。
if (Object.keys(newSingleKeys).length) {
  const providersPath = join(mcpDir, "providers.json");
  const existing = existsSync(providersPath) ? safeParse(readFileSync(providersPath, "utf8")) : {};
  const next = { ...existing, api_keys: { ...(existing.api_keys || {}) } };
  for (const [provider, value] of Object.entries(newSingleKeys)) {
    next.api_keys[provider] = [value];
  }
  writeSecret(providersPath, `${JSON.stringify(next, null, 2)}\n`);
}

// 3) 社交登录态。
if (twitter) {
  const socialPath = join(mcpDir, "social.env");
  const existing = readEnvFile(socialPath);
  existing.TWITTER_AUTH_TOKEN = twitter.authToken;
  existing.TWITTER_CT0 = twitter.ct0;
  writeSecret(socialPath, toEnvFile(existing));
}

// 4) mcporter：只更新 exa* 实例，不删除其他实例；同 name 冲突时报告而非静默覆盖。
if (newMultiKeys.exa) {
  const mcporterPath = join(home, ".mcporter", "mcporter.json");
  const mcporter = existsSync(mcporterPath) ? safeParse(readFileSync(mcporterPath, "utf8")) : { mcpServers: {}, imports: [] };
  mcporter.mcpServers ??= {};
  const desired = {};
  newMultiKeys.exa.forEach((key, index) => {
    const name = index === 0 ? "exa" : `exa${index + 1}`;
    desired[name] = { baseUrl: `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(key)}` };
  });
  for (const [name, config] of Object.entries(desired)) {
    const current = mcporter.mcpServers[name];
    if (current && current.baseUrl && current.baseUrl !== config.baseUrl) {
      console.warn(`提示: mcporter 实例 ${name} 已存在且不同，将更新为本次提供的 key（原值已备份）。`);
    }
    mcporter.mcpServers[name] = config;
  }
  if (existsSync(mcporterPath)) backupFile(mcporterPath);
  writeSecret(mcporterPath, `${JSON.stringify(mcporter, null, 2)}\n`);
}

if (data.reddit) {
  const redditPath = join(home, ".config", "rdt-cli", "credential.json");
  if (existsSync(redditPath)) backupFile(redditPath);
  writeSecret(redditPath, `${JSON.stringify(data.reddit, null, 2)}\n`);
}

console.log(JSON.stringify({
  imported: {
    tavily: provided.tavily?.length ?? 0,
    exa: provided.exa?.length ?? 0,
    singleKeys: Object.keys(newSingleKeys),
    twitter: Boolean(twitter),
    reddit: Boolean(data.reddit),
  },
  modified: targets,
  note: "合并写入；未提供的 provider 保留原值。重启 ZCode/MCP 进程后生效。",
}, null, 2));

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    console.error(`Missing ${label}`); // 只报字段名
    process.exit(2);
  }
  return value.trim();
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    console.error("目标文件存在但不是有效 JSON；已中止以避免覆盖。请先手动检查。");
    process.exit(2);
  }
}

function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

function toEnvFile(map) {
  return `${Object.entries(map).map(([k, v]) => `${k}=${shellQuote(v)}`).join("\n")}\n`;
}

/** 合并 key 列表并去重，保留原有顺序。 */
function mergeKeyList(existingValue, incoming) {
  const existing = String(existingValue || "").split(",").map((s) => s.trim()).filter(Boolean);
  const merged = [...existing];
  for (const item of incoming) if (!merged.includes(item)) merged.push(item);
  return merged;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function backupFile(path) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.bak.${stamp}`;
  writeFileSync(backup, readFileSync(path), { mode: 0o600 });
  chmodSync(backup, 0o600);
  console.log(`已备份: ${backup}`);
}

function writeSecret(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, content, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
