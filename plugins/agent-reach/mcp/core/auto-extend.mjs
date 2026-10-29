/**
 * 深度档自动延伸：从首轮证据确定性提取关键词，生成下一轮扩展查询。
 * 零依赖、无 LLM 调用；同一输入产生同一输出，便于测试与复现。
 * 停止条件由调用方控制（轮次/预算/无新增证据），本模块只负责"下一批查什么"。
 */

// 中英文停用词：模板词本身也过滤，避免"方案 方案"式自循环。
const STOPWORDS = new Set([
  "的", "了", "和", "与", "在", "是", "有", "为", "到", "及", "或", "等", "对", "从", "你", "我", "我们",
  "如何", "怎么", "什么", "哪些", "一个", "一下", "最新", "今天", "推荐", "比较",
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "how", "what", "is", "are", "best", "top",
  "vs", "guide", "review", "example", "examples", "tutorial", "case",
  // 网页噪声词：JSON 片段与规格单位不产生有效扩展词
  "url", "http", "https", "www", "com", "cn", "net", "org", "gb", "mb", "tb",
]);

/** 扩展模板：按查询语言选择，按轮次轮换，避免两轮撞同批后缀。 */
const TEMPLATES_ZH = ["案例", "经验 教程", "对比 评测", "常见问题", "最新进展"];
const TEMPLATES_EN = ["examples", "tutorial", "comparison", "best practices", "pitfalls"];

function isMostlyAscii(text) {
  const ascii = (text.match(/[\x20-\x7e]/g) || []).length;
  return ascii >= String(text).length * 0.7;
}

/** 从标题/摘要提取关键词频次：标题权重 2，摘要权重 1。 */
export function extractKeywords(query, evidence, { top = 6 } = {}) {
  const freq = new Map();
  const add = (token, weight) => {
    const t = token.trim().toLowerCase();
    if (t.length < 2 || t.length > 24) return;
    if (STOPWORDS.has(t)) return;
    if (/^\d+$/.test(t)) return;
    freq.set(t, (freq.get(t) || 0) + weight);
  };
  for (const e of evidence || []) {
    const fields = [[e.title, 2], [e.excerpt, 1]];
    for (const [text, weight] of fields) {
      const s = String(text || "");
      for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9+#._-]{1,}/g)) add(m[0], weight);
      for (const m of s.matchAll(/[一-鿿]{2,}/g)) {
        const run = m[0];
        if (run.length <= 8) add(run, weight);
        // 长串补 4 字滑窗，提高"向量数据库"式复合词的命中概率。
        for (let i = 0; i + 4 <= Math.min(run.length, 24); i += 2) add(run.slice(i, i + 4), weight * 0.5);
      }
    }
  }
  // 原查询里已出现的词不再作为延伸关键词
  const queryTokens = new Set();
  for (const m of String(query).matchAll(/[A-Za-z][A-Za-z0-9+#._-]{1,}|[一-鿿]{2,}/g)) {
    queryTokens.add(m[0].toLowerCase());
  }
  return [...freq.entries()]
    .filter(([t]) => ![...queryTokens].some((q) => t.includes(q) || q.includes(t)))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([t]) => t);
}

/**
 * 生成下一批扩展查询（最多 max 条）。
 * 策略：关键词补强 + 模板后缀；与 usedQueries 去重；没有证据时返回空（调用方据此停止）。
 */
export function deriveExpansionQueries(query, evidence, { usedQueries = new Set(), round = 2, max = 3 } = {}) {
  if (!evidence || evidence.length === 0) return [];
  const keywords = extractKeywords(query, evidence);
  const templates = isMostlyAscii(query) ? TEMPLATES_EN : TEMPLATES_ZH;
  const candidates = [];
  if (keywords[0]) candidates.push(`${query} ${keywords[0]}`);
  if (keywords[1]) candidates.push(`${query} ${keywords[1]} ${templates[(round - 2) % templates.length]}`);
  candidates.push(`${query} ${templates[(round - 1) % templates.length]}`);
  if (keywords[0] && keywords[1]) candidates.push(`${keywords[0]} ${keywords[1]}`);
  const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const out = [];
  for (const c of candidates) {
    const n = norm(c);
    if (n === norm(query) || usedQueries.has(n)) continue;
    usedQueries.add(n);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}
