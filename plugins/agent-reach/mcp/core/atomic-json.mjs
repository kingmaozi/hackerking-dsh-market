/**
 * 共享的原子 JSON 写入：tmp 文件 0600 + rename，避免半写状态。
 * 供 runs 快照、授权计数回写、授权脚本复用。
 */

import { chmodSync, renameSync, writeFileSync } from "node:fs";

export function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
