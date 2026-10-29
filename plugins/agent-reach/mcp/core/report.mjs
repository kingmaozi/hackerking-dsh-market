/**
 * 报告层：完整 JSON 分页、证据引用校验与确定性证据附录。
 * 只做结构化渲染与校验，不判断事实真伪、不撰写结论。
 */

import { validateClaim } from "./contracts.mjs";

export function validateClaims(claims, evidence) {
  const ids = new Set((evidence || []).map((e) => e.id));
  return (claims || []).map((claim) => validateClaim(claim, ids));
}

export function jsonResponse(value, { maxBytes = 48 * 1024 } = {}) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= maxBytes) return { text, truncated: false };
  // 超出时只保留结构并提示分页，不切断 JSON。
  const trimmed = {
    ...value,
    evidence: (value.evidence || []).slice(0, 3),
    nextCursor: value.nextCursor || null,
    warnings: [...(value.warnings || []), `结果超过 ${maxBytes} 字节，请使用 cursor 分页获取剩余证据`],
  };
  return { text: JSON.stringify(trimmed, null, 2), truncated: true };
}

/** 确定性证据附录：不生成结论，只呈现来源与状态。 */
export function renderEvidenceReport(snapshot) {
  const lines = [];
  lines.push(`# 研究运行 ${snapshot.runId}`);
  lines.push(`状态: ${snapshot.state} · 档位: ${snapshot.tier} · 轮次: ${snapshot.rounds}`);
  lines.push(`查询: ${snapshot.query}`);
  lines.push("");
  lines.push("## 渠道覆盖");
  for (const item of snapshot.coverage || []) {
    lines.push(`- ${item.provider}: ${item.status}${item.reason ? ` — ${item.reason}` : ""}`);
  }
  lines.push("");
  lines.push("## 证据");
  if (!snapshot.evidence?.length) lines.push("(无证据；不得据此生成有引用的结论)");
  for (const item of snapshot.evidence || []) {
    lines.push(`### [${item.id}] ${item.title || item.canonicalUrl}`);
    lines.push(`- 来源: ${item.provider} (${item.actualBackend}) · 类型: ${item.excerptType} · 发布时间: ${item.publishedAt || "未知"}`);
    lines.push(`- 链接: ${item.canonicalUrl}`);
    if (item.warnings?.length) lines.push(`- 提示: ${item.warnings.join(", ")}`);
    lines.push("");
    lines.push((item.excerpt || "").slice(0, 800));
    lines.push("");
  }
  if (snapshot.claims?.length) {
    lines.push("## 结论与证据映射");
    for (const claim of snapshot.claims) {
      lines.push(`- [${claim.status}] ${claim.text}`);
      if (claim.supports.length) lines.push(`  支持: ${claim.supports.join(", ")}`);
      if (claim.contradicts.length) lines.push(`  反例: ${claim.contradicts.join(", ")}`);
    }
    lines.push("");
  }
  if (snapshot.warnings?.length) {
    lines.push("## 运行提示");
    for (const w of snapshot.warnings.slice(0, 40)) lines.push(`- ${w}`);
    lines.push("");
  }
  return lines.join("\n");
}
