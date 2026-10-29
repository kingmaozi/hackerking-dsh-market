import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import { ImpersonatedSession } from "./http.js";
// Image generation runs through the Codex Responses endpoint + the hosted
// image_generation tool. The direct REST /images/generations route is not
// deployed on the production backend (404), so we drive the tool via /responses
// and read the image out of the SSE stream.
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_VERSION = "0.135.0";
const REQUEST_TIMEOUT_S = 600;
const MAX_EDIT_IMAGES = 5;
const MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
};
/** Validation/usage error → CLI exit code 2. */
export function usageError(message) {
    return Object.assign(new Error(message), { exitCode: 2 });
}
function headers(token, accountId, sessionId) {
    return {
        Authorization: `Bearer ${token}`,
        ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
        originator: "codex_cli_rs",
        "User-Agent": `codex_cli_rs/${CODEX_VERSION}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-codex-turn-metadata": JSON.stringify({
            session_id: sessionId,
            turn_id: randomUUID(),
            sandbox: "seatbelt",
        }),
    };
}
/** Read an input image and return a base64 data URL. Throws usageError on problems. */
export function imageToDataUrl(path) {
    if (!existsSync(path))
        throw usageError(`输入图不存在: ${path}`);
    const ext = extname(path).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
        throw usageError(`不支持的图片类型: ${ext || "(无扩展名)"}（支持 png/jpg/jpeg/webp/gif）`);
    }
    return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}
/**
 * 提交前校验 size。返回 null 表示可用，否则返回给调用方的错误说明。
 *
 * 实测（2026-10-06 全矩阵）：后端**不会**因为尺寸越界报错，而是静默忽略/收敛
 * （请求 4000x1000 拿到 1254x1254）。所以越界时在这里直接拒绝，
 * 免得不报错却交付一张与请求无关的画面。
 */
export function validateSize(size) {
    if (size === undefined || size === null || size === "" || size === "auto")
        return null;
    const text = String(size).trim();
    const match = /^(\d+)x(\d+)$/.exec(text);
    if (!match)
        return `size 只能是 auto 或 WIDTHxHEIGHT（如 1024x1024），收到: ${text}`;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width % 16 !== 0 || height % 16 !== 0)
        return `size 的两条边都必须是 16 的倍数，收到: ${text}`;
    if (Math.max(width, height) > 3840)
        return `size 的最长边必须 ≤ 3840，收到: ${text}`;
    if (Math.max(width, height) / Math.min(width, height) > 3)
        return `size 的长短边比必须 ≤ 3:1（超过 3:1 这条通道拿不到），收到: ${text}`;
    const pixels = width * height;
    if (pixels < 655360 || pixels > 8294400)
        return `size 的总像素需在 655,360 ~ 8,294,400 之间，收到: ${text}（${pixels} 像素）`;
    return null;
}

/** image_generation tool config. Non-auto size/quality/background are passed through.
 *  注意：实测 size 基本无效（4K 请求也被收敛到约 1.5MP），画幅请写进 prompt。 */
export function imageTool(o) {
    const tool = { type: "image_generation" };
    if (o.size && o.size !== "auto")
        tool["size"] = o.size;
    if (o.quality && o.quality !== "auto")
        tool["quality"] = o.quality;
    if (o.background && o.background !== "auto")
        tool["background"] = o.background;
    return tool;
}
export function buildRequest(o, imageParts) {
    const content = [
        { type: "input_text", text: o.prompt },
        ...imageParts,
    ];
    return {
        model: o.model,
        instructions: "You are an image generation assistant. When the user requests an image, " +
            "immediately call the image_generation tool to create or edit it. Do not ask clarifying questions.",
        input: [{ type: "message", role: "user", content }],
        tools: [imageTool(o)],
        tool_choice: "auto",
        stream: true,
        store: false,
        reasoning: { effort: o.effort || "xhigh" },
        text: { verbosity: "low" },
        include: ["reasoning.encrypted_content"],
    };
}
function parseSse(text) {
    const events = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:"))
            continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]")
            continue;
        try {
            events.push(JSON.parse(data));
        }
        catch {
            /* skip non-JSON keepalive lines */
        }
    }
    return events;
}
function asLongB64(value) {
    return typeof value === "string" && value.length > 100 ? value : null;
}
/** Pull the generated image out of the SSE event stream.
 *  Prefers the final result on response.output_item.done; falls back to the
 *  last progressive partial_image. Exported for unit testing. */
export function extractImage(text) {
    const events = parseSse(text);
    let finalB64 = null;
    let partialB64 = null;
    let size = "";
    let quality = "";
    let revisedPrompt = "";
    for (const e of events) {
        const item = e.item;
        if (e.type === "response.output_item.done" && item && item["type"] === "image_generation_call") {
            const b = asLongB64(item["result"]);
            if (b) {
                finalB64 = b;
                if (typeof item["size"] === "string")
                    size = item["size"];
                if (typeof item["quality"] === "string")
                    quality = item["quality"];
                if (typeof item["revised_prompt"] === "string")
                    revisedPrompt = item["revised_prompt"];
            }
        }
        else if (typeof e.type === "string" && e.type.includes("partial_image")) {
            const b = asLongB64(e["partial_image_b64"]) ?? asLongB64(e["result"]);
            if (b)
                partialB64 = b;
        }
    }
    const b64 = finalB64 ?? partialB64;
    if (!b64) {
        const fail = events.find((e) => e.type === "response.failed" || e.type === "error");
        throw new Error(`图片生成失败：${describeFailure(fail) ?? "后端未返回图片"}`);
    }
    return { b64, size, quality, revisedPrompt };
}
function describeFailure(event) {
    if (!event)
        return null;
    const resp = event["response"];
    const err = event["error"] ??
        resp?.["error"];
    return err?.["message"] ?? null;
}
function mapHttpError(status, text) {
    const detail = extractMessage(text);
    if (status === 401 || status === 403) {
        return new Error(`认证/权限失败 (${status})：账号可能是免费号，图片生成需 Plus/Pro。${detail}`);
    }
    if (status === 429)
        return new Error(`撞限流 (429)：稍后再试。${detail}`);
    if (status === 400)
        return new Error(`请求被拒 (400)：${detail}`);
    return new Error(`后端返回 ${status}。${detail}`);
}
function extractMessage(text) {
    if (!text)
        return "";
    try {
        const j = JSON.parse(text);
        return j.error?.message ?? j.message ?? j.detail ?? text.slice(0, 300);
    }
    catch {
        return text.slice(0, 300);
    }
}
async function runRequest(token, accountId, sessionId, tlsProfile, request) {
    const session = new ImpersonatedSession(REQUEST_TIMEOUT_S, tlsProfile.ja3, tlsProfile.akamai);
    try {
        const res = await session.post(RESPONSES_URL, headers(token, accountId, sessionId), JSON.stringify(request));
        if (res.status !== 200)
            throw mapHttpError(res.status, res.text);
        return extractImage(res.text);
    }
    finally {
        session.close();
    }
}
export async function generate(token, accountId, sessionId, tlsProfile, o) {
    return runRequest(token, accountId, sessionId, tlsProfile, buildRequest(o, []));
}
export async function edit(token, accountId, sessionId, tlsProfile, o) {
    if (o.imagePaths.length < 1 || o.imagePaths.length > MAX_EDIT_IMAGES) {
        throw usageError(`图生图需要 1~${MAX_EDIT_IMAGES} 张输入图，收到 ${o.imagePaths.length} 张`);
    }
    const parts = o.imagePaths.map((p) => ({ type: "input_image", image_url: imageToDataUrl(p) }));
    return runRequest(token, accountId, sessionId, tlsProfile, buildRequest(o, parts));
}
