import { writeFileSync } from "node:fs";
import { extname } from "node:path";

const QUALITY_RANK = { low: 1, medium: 2, high: 3 };

/**
 * 回执里的 quality 说明。后端会静默改写请求的 quality（2026-10-06 矩阵实测：
 * 12 次 medium 请求里 6 次落到 low，也有 low 被提升到 medium），所以只报实际值。
 */
export function formatQualityNote(requestedQuality, actualQuality) {
    if (!actualQuality || actualQuality === "auto")
        return "";
    if (requestedQuality && requestedQuality !== "auto" && actualQuality !== requestedQuality) {
        const delta = (QUALITY_RANK[actualQuality] ?? 0) - (QUALITY_RANK[requestedQuality] ?? 0);
        const how = delta < 0 ? "被后端降级" : delta > 0 ? "被后端提升" : "被后端改写";
        return `quality=${actualQuality}（请求 ${requestedQuality}，${how}，可重跑一次）`;
    }
    return `quality=${actualQuality}`;
}
/**
 * Decode base64 PNGs and write to disk.
 * Single image → outPath; multiple → outPath with "-1", "-2", … before the extension.
 * Returns the list of written paths.
 */
export function saveImages(b64s, outPath) {
    if (b64s.length === 0) {
        throw new Error("没有图片可保存");
    }
    if (b64s.length === 1) {
        const only = b64s[0];
        if (!only)
            throw new Error("没有图片可保存");
        writeFileSync(outPath, Buffer.from(only, "base64"));
        return [outPath];
    }
    const ext = extname(outPath) || ".png";
    const base = outPath.slice(0, outPath.length - ext.length);
    return b64s.map((b, i) => {
        const p = `${base}-${i + 1}${ext}`;
        writeFileSync(p, Buffer.from(b, "base64"));
        return p;
    });
}
