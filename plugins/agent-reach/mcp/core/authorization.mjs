/**
 * 钱包/桌面操作授权：只接受本机由用户创建并确认过的授权文件。
 * 模型传入的 approved=true 不构成授权。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic-json.mjs";

export const AUTHORIZATION_FILE = join(homedir(), ".agent-reach", "briking", "authorizations.json");

const REQUIRED_FIELDS = ["provider", "purpose", "maxAmount", "currency", "maxTasks", "expiresAt", "confirmedBy"];

/**
 * 校验授权引用。返回 {ok, reason, allowBrowser, maxAmount, currency}。
 * 任一必需字段缺失、过期、次数用尽或金额未知，都视为未授权。
 */
export function validateAuthorization(ref, task, authorization, now = Date.now()) {
  if (!ref) return { ok: false, reason: "缺少 authorizationRef：付费/桌面操作需要本机用户授权引用" };
  if (!authorization) return { ok: false, reason: "未找到本机授权文件 ~/.agent-reach/briking/authorizations.json" };
  const entry = (authorization.grants || []).find((g) => g.id === ref);
  if (!entry) return { ok: false, reason: `授权引用不存在或已被移除: ${ref}` };
  for (const field of REQUIRED_FIELDS) {
    if (entry[field] === undefined || entry[field] === null || entry[field] === "") {
      return { ok: false, reason: `授权缺少必需字段 ${field}，视为未授权` };
    }
  }
  if (entry.revoked) return { ok: false, reason: "授权已被用户撤销" };
  if (entry.provider !== task.provider) {
    return { ok: false, reason: `授权用于 ${entry.provider}，与任务 ${task.provider} 不符` };
  }
  const expires = Date.parse(entry.expiresAt);
  if (Number.isNaN(expires) || expires <= now) return { ok: false, reason: "授权已过期" };
  if (!Number.isFinite(entry.maxAmount) || entry.maxAmount <= 0) {
    return { ok: false, reason: "授权金额上限无效；费用不可限定时默认阻止" };
  }
  if (!Number.isInteger(entry.maxTasks) || entry.maxTasks <= 0) return { ok: false, reason: "授权任务次数无效" };
  const used = Number.isInteger(entry.usedTasks) ? entry.usedTasks : 0;
  if (used >= entry.maxTasks) return { ok: false, reason: `授权任务次数已用尽（${used}/${entry.maxTasks}）` };
  if (entry.allowedDepths && task.input?.externalDepth && !entry.allowedDepths.includes(task.input.externalDepth)) {
    return { ok: false, reason: `该深度 ${task.input.externalDepth} 未在授权范围内` };
  }
  return {
    ok: true,
    reason: null,
    allowBrowser: Boolean(entry.allowBrowser),
    maxAmount: entry.maxAmount,
    currency: entry.currency,
    purpose: entry.purpose,
  };
}

export function loadAuthorizations({ home = homedir(), file } = {}) {
  const path = file || join(home, ".agent-reach", "briking", "authorizations.json");
  if (!existsSync(path)) return { grants: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed?.grants)) return { grants: [] };
    // 记录来源路径（不可枚举，不随 JSON 序列化），供计数回写找到同一文件。
    Object.defineProperty(parsed, "__file", { value: path, enumerable: false, configurable: true });
    return parsed;
  } catch {
    return { grants: [] };
  }
}

/**
 * 供 createProvider 使用的授权器工厂。
 * 返回的 authorize(providerId, task) 只做校验；authorize.consume(providerId, task)
 * 在任务实际派发时消耗一次授权次数（内存副本与授权文件同步递增）。
 */
export function createAuthorizer(authorization, now = () => Date.now(), options = {}) {
  const authorize = (providerId, task) =>
    validateAuthorization(task?.authorizationRef, { provider: providerId, input: task?.input || {} }, authorization, now());

  authorize.consume = (providerId, task) => {
    const ref = task?.authorizationRef;
    if (!ref) return { ok: false, error: "缺少 authorizationRef，无法计数" };
    const file = options.file || authorization.__file || AUTHORIZATION_FILE;
    // 多写者合并：先重读磁盘，按 id 合并（usedTasks 取大、保留磁盘上新增的授权），
    // 避免用启动时的陈旧快照整体覆盖运行期间由脚本新增的授权。
    let mergedGrants = authorization.grants || [];
    let diskDoc = {};
    try {
      if (existsSync(file)) {
        const onDisk = JSON.parse(readFileSync(file, "utf8"));
        if (Array.isArray(onDisk?.grants)) {
          diskDoc = onDisk;
          const byId = new Map(onDisk.grants.map((g) => [g.id, g]));
          for (const g of mergedGrants) {
            const d = byId.get(g.id);
            if (d) d.usedTasks = Math.max(Number.isInteger(d.usedTasks) ? d.usedTasks : 0, Number.isInteger(g.usedTasks) ? g.usedTasks : 0);
            else byId.set(g.id, { ...g });
          }
          mergedGrants = [...byId.values()];
        }
      }
    } catch { /* 磁盘读取失败时按内存快照继续 */ }
    const entry = mergedGrants.find((g) => g.id === ref);
    if (!entry) return { ok: false, error: "授权引用不存在，无法计数" };
    const used = Number.isInteger(entry.usedTasks) ? entry.usedTasks : 0;
    if (Number.isInteger(entry.maxTasks) && used >= entry.maxTasks) {
      // 合并磁盘计数后已用尽：与 validateAuthorization 同语义，按 budget 拒绝。
      return { ok: false, exhausted: true, error: `授权任务次数已用尽（${used}/${entry.maxTasks}）` };
    }
    entry.usedTasks = used + 1;
    // 内存副本同步到合并后的最新计数，后续校验立即可见。
    const memoryEntry = (authorization.grants || []).find((g) => g.id === ref);
    if (memoryEntry) memoryEntry.usedTasks = entry.usedTasks;
    try {
      writeJsonAtomic(file, { ...diskDoc, grants: mergedGrants });
      return { ok: true, usedTasks: entry.usedTasks };
    } catch (err) {
      // 持久化失败不阻断已授权的任务：内存计数仍生效（本进程内），如实告警。
      return { ok: false, usedTasks: entry.usedTasks, error: `授权计数持久化失败: ${err.message}` };
    }
  };
  return authorize;
}
