// dsh-composer-prediction — shared pure logic.
//
// Imported by the host half (lib/index.js, real ESM) and inlined into the
// browser bundle by scripts/build-client.mjs (which strips `export ` keywords,
// so this file must contain nothing but plain declarations + exports).
//
// Nothing here touches Node, the DOM, or React: it is safe in both worlds and
// unit-testable on its own.

/** Settings namespace (also the settings-card key) and RPC identities. */
export const NS = 'composer-predict'
export const ROUTE = '/api/composer-predict/rpc'
export const CHANNEL = '/composer-predict'

/** Config defaults, mirrored by the host schemastery schema. */
export const DEFAULT_CONFIG = {
	enabled: true,
	/**
	 * Model route. Empty means "use the deployment default that fresh agents
	 * start on" (ctx.agentDefaultModel), which is what a normal install wants:
	 * the plugin then rides the same provider and credentials as the session.
	 */
	provider: '',
	model: '',
	/** Direct-HTTP fallback only: used when no harness LLM service is composed. */
	baseUrl: 'https://api.deepseek.com',
	apiKey: '',
	/**
	 * Output budget for one prediction. A reasoning model spends part of this on
	 * hidden thinking before it emits the suggestion, so a tiny cap (the first
	 * version used 64) produced empty answers rather than short ones.
	 */
	maxTokens: 512,
	temperature: 0.8,
	/**
	 * Reasoning effort policy for the harness transport:
	 *   'auto'     — leave the provider/model default alone (best quality)
	 *   'cheapest' — pin the model's cheapest advertised effort (fastest)
	 *   '<id>'     — one advertised effort id
	 */
	reasoningEffort: 'auto',
	/** How many ranked alternatives to ask for; the ghost shows the first. */
	candidates: 3,
	/**
	 * Host-managed: lines this user actually accepted, newest last. Fed back into
	 * the prompt as phrasing examples; never edited from the browser.
	 */
	styleSamples: [],
	/** Ask as soon as the turn ends; typing still cancels the request. */
	delayMs: 0,
	/** Hard cap for the offered suggestion; longer answers are truncated. */
	maxSuggestionChars: 200,
	/** How many trailing conversation messages feed the predictor. */
	contextMessages: 10,
	/** Character budget for the transcript block. */
	maxContextChars: 6000,
}

/** Coerce to a finite integer inside [min, max], or the fallback. */
export function clampNumber(value, min, max, fallback) {
	const n = Number(value)
	if (!Number.isFinite(n)) return fallback
	return Math.min(max, Math.max(min, Math.round(n)))
}

/** Coerce to a finite float inside [min, max], or the fallback. */
export function clampFloat(value, min, max, fallback) {
	const n = Number(value)
	if (!Number.isFinite(n)) return fallback
	return Math.min(max, Math.max(min, n))
}

/** Join the text blocks of a user/assistant node, ignoring tool and image parts. */
export function textOfBlocks(blocks) {
	if (!Array.isArray(blocks)) return ''
	const parts = []
	for (const block of blocks) {
		if (block === null || typeof block !== 'object') continue
		if (block.kind === 'text' && typeof block.text === 'string') parts.push(block.text)
	}
	return parts.join('\n')
}

/**
 * Extract a chronological tail of the conversation from Chat nodes.
 * User, steering and assistant nodes participate; tool results, context
 * injections, compaction markers and commands are noise for prediction.
 *
 * @param nodes  `useChat(snapshot => snapshot.legacy.nodes)`
 * @param options `{ limit, maxChars }`
 * @returns `[{ role: 'user' | 'assistant', content: string }]`
 */
export function extractTail(nodes, options) {
	const opts = options ?? {}
	const limit = clampNumber(opts.limit, 1, 40, DEFAULT_CONFIG.contextMessages)
	const maxChars = clampNumber(opts.maxChars, 200, 100000, DEFAULT_CONFIG.maxContextChars)
	const list = Array.isArray(nodes) ? nodes : []
	const out = []
	let chars = 0
	for (let i = list.length - 1; i >= 0 && out.length < limit; i -= 1) {
		const node = list[i]
		if (node === null || typeof node !== 'object') continue
		let role = ''
		let text = ''
		if (node.kind === 'user' || node.kind === 'steering') {
			role = 'user'
			text = textOfBlocks(node.content)
		} else if (node.kind === 'assistant') {
			role = 'assistant'
			text = textOfBlocks(node.blocks)
		} else {
			continue
		}
		text = text.trim()
		if (text === '') continue
		const room = maxChars - chars
		if (room < 40) break
		if (text.length > room) text = text.slice(text.length - room)
		out.unshift({ role, content: text })
		chars += text.length
	}
	return out
}

/** Seq of the newest assistant node, or 0 — the identity of one finished turn. */
export function lastAssistantSeq(nodes) {
	const list = Array.isArray(nodes) ? nodes : []
	for (let i = list.length - 1; i >= 0; i -= 1) {
		const node = list[i]
		if (node !== null && typeof node === 'object' && node.kind === 'assistant') {
			return typeof node.seq === 'number' ? node.seq : 0
		}
	}
	return 0
}

const QUOTE_PAIRS = [
	['"', '"'],
	["'", "'"],
	['\u201c', '\u201d'],
	['\u300c', '\u300d'],
	['`', '`'],
]

/** List markers a model may put in front of a candidate line. */
const LIST_MARKER_RE = /^\s*(?:\d{1,2}\s*[.)\uff09]|[-\u2022]|\*(?!\*))\s*/

/** Drop numbering, speaker labels, wrapping quotes and trailing junk from one line. */
function cleanSuggestion(raw, maxChars) {
	if (typeof raw !== 'string') return ''
	let text = raw.replace(/\r/g, '').trim()
	if (text === '') return ''

	// A fenced block is never a composer suggestion; take its first line.
	text = text.replace(/^```[A-Za-z0-9_-]*\s*/, '').replace(/```\s*$/, '').trim()

	// Models like to number ranked candidates even when asked not to.
	text = text.replace(LIST_MARKER_RE, '').trim()

	// Drop speaker labels the model may have echoed back.
	text = text.replace(/^(?:next|user|you|suggestion|prediction|candidate)\s*[:\uff1a]\s*/i, '')

	// Strip wrapping quotes, repeatedly (nested quoting is common).
	let stripped = true
	while (stripped) {
		stripped = false
		for (const pair of QUOTE_PAIRS) {
			if (text.length > 1 && text.startsWith(pair[0]) && text.endsWith(pair[1])) {
				text = text.slice(1, -1).trim()
				stripped = true
			}
		}
	}

	text = text.replace(/\s+/g, ' ').trim()
	if (text === '') return ''

	// Explicit refusal.
	if (/^none[.!]?$/i.test(text)) return ''

	// Assistant-voiced openers are a prediction failure, not a suggestion.
	if (/^(?:sure|certainly|of course|here(?:'s| is)|i(?:'ve| have) (?:updated|fixed|added))\b/i.test(text)) return ''

	if (text.length > maxChars) {
		text = text.slice(0, maxChars)
		const cut = text.lastIndexOf(' ')
		if (cut > maxChars * 0.6) text = text.slice(0, cut)
		text = text.replace(/[\s,;:.!?\u2026-]+$/, '')
	}
	return text
}

/**
 * One raw model answer -> the ranked `[best, ...]` suggestions worth offering.
 *
 * The prompt asks for one candidate per line, best first. Anything that fails
 * the contract (assistant voice, explicit NONE, empty after cleanup) is removed
 * instead of shown, and duplicates collapse so Tab never inserts the same line
 * twice.
 */
export function normalizeSuggestions(raw, options) {
	const opts = options ?? {}
	const maxChars = clampNumber(opts.maxChars, 20, 2000, DEFAULT_CONFIG.maxSuggestionChars)
	const limit = clampNumber(opts.candidates, 1, 5, DEFAULT_CONFIG.candidates)
	if (typeof raw !== 'string') return []
	const lines = raw.replace(/\r/g, '').split('\n')
	const seen = new Set()
	const out = []
	for (const line of lines) {
		const cleaned = cleanSuggestion(line, maxChars)
		if (cleaned === '') continue
		const key = cleaned.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		out.push(cleaned)
		if (out.length >= limit) break
	}
	return out
}

/** Backwards-compatible single suggestion: the top-ranked candidate, or ''. */
export function normalizeSuggestion(raw, options) {
	return normalizeSuggestions(raw, options)[0] ?? ''
}

/**
 * The system prompt that turns a chat model into a next-user-message predictor.
 *
 * The first version asked for one <=20-word line and offered an easy NONE exit;
 * with a reasoning model pinned to its cheapest effort that produced almost no
 * offers. This version asks for ranked alternatives, tells the model how to read
 * what the last assistant turn left unfinished, and lets the caller inject a few
 * lines the developer actually sent before so the phrasing matches them.
 */
export function buildSystemPrompt(options) {
	const opts = options ?? {}
	const count = clampNumber(opts.candidates, 1, 5, DEFAULT_CONFIG.candidates)
	const samples = (Array.isArray(opts.styleSamples) ? opts.styleSamples : [])
		.filter((sample) => typeof sample === 'string' && sample.trim() !== '')
		.slice(0, 8)
	const lines = [
		'You are the composer autocomplete for a developer chatting with a coding agent.',
		'Given the recent conversation, write what this developer is most likely to type next.',
		'',
		'How to read the conversation:',
		'- The last Assistant turn just finished. Judge what it left open: an unrun test, an unverified claim, a diff to review, a decision to take, a step it proposed.',
		"- Mirror the developer's own voice, length and language: terse Chinese gets terse Chinese, English gets English.",
		'- Prefer a concrete instruction the developer would actually send (run the suite, fix the failing case, commit this, explain why, go ahead, looks good) over a vague restatement.',
		'',
		'Output rules:',
		`- Reply with up to ${count} alternative messages, one per line, most likely first.`,
		'- One line per message: no numbering, no bullets, no quotes, no markdown, no labels, no explanation.',
		'- Each line is only the message itself, normally under 25 words.',
		'- Never answer as the assistant, never restate what the assistant just said, never narrate your own reasoning.',
		'- Reply NONE only when nothing plausible could be sent next.',
	]
	if (samples.length > 0) {
		lines.push('', 'This developer has actually sent lines like these before — match their phrasing:', ...samples.map((sample) => `- ${sample.trim()}`))
	}
	return lines.join('\n')
}

/**
 * Build the model-visible prompt once, for both transports.
 * `system` is the predictor instruction; `input` is the transcript framed as a
 * single user turn (a trailing assistant turn would make the model continue as
 * the assistant instead of writing the user's next message).
 */
export function buildPrompt(tail, options) {
	const messages = Array.isArray(tail) ? tail : []
	const opts = options ?? {}
	const system = buildSystemPrompt(opts)
	if (messages.length === 0) return { system, input: '' }
	const transcript = messages
		.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
		.join('\n\n')
	const count = clampNumber(opts.candidates, 1, 5, DEFAULT_CONFIG.candidates)
	const closing =
		count > 1
			? `Write the developer's next message now: up to ${count} alternatives, one per line, best first.`
			: "Write the developer's next message now. Reply with the message only."
	return { system, input: `Conversation so far:\n\n${transcript}\n\n${closing}` }
}

/** Build chat messages for the direct-HTTP transport. */
export function toApiMessages(tail) {
	const prompt = buildPrompt(tail)
	if (prompt.input === '') return []
	return [
		{ role: 'system', content: prompt.system },
		{ role: 'user', content: prompt.input },
	]
}

/** Sanitize an untrusted config pickle from the browser before persisting it. */
export function sanitizeConfigPatch(patch) {
	const out = {}
	if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return out
	const put = (key, value) => {
		out[key] = value
	}
	if (typeof patch.enabled === 'boolean') put('enabled', patch.enabled)
	if (typeof patch.provider === 'string') put('provider', patch.provider.trim().slice(0, 120))
	if (typeof patch.baseUrl === 'string') put('baseUrl', patch.baseUrl.trim().slice(0, 400))
	if (typeof patch.apiKey === 'string') put('apiKey', patch.apiKey.trim().slice(0, 400))
	if (typeof patch.model === 'string') put('model', patch.model.trim().slice(0, 120))
	if (patch.maxTokens !== undefined) put('maxTokens', clampNumber(patch.maxTokens, 64, 2048, DEFAULT_CONFIG.maxTokens))
	if (patch.temperature !== undefined) put('temperature', clampFloat(patch.temperature, 0, 2, DEFAULT_CONFIG.temperature))
	if (patch.candidates !== undefined) put('candidates', clampNumber(patch.candidates, 1, 5, DEFAULT_CONFIG.candidates))
	if (typeof patch.reasoningEffort === 'string') {
		const effort = patch.reasoningEffort.trim()
		if (/^(?:auto|cheapest|[A-Za-z0-9._-]{1,40})$/.test(effort)) put('reasoningEffort', effort)
	}
	if (patch.delayMs !== undefined) put('delayMs', clampNumber(patch.delayMs, 0, 30000, DEFAULT_CONFIG.delayMs))
	if (patch.maxSuggestionChars !== undefined) {
		put('maxSuggestionChars', clampNumber(patch.maxSuggestionChars, 20, 2000, DEFAULT_CONFIG.maxSuggestionChars))
	}
	if (patch.contextMessages !== undefined) {
		put('contextMessages', clampNumber(patch.contextMessages, 1, 40, DEFAULT_CONFIG.contextMessages))
	}
	if (patch.maxContextChars !== undefined) {
		put('maxContextChars', clampNumber(patch.maxContextChars, 200, 100000, DEFAULT_CONFIG.maxContextChars))
	}
	return out
}

// ———— model route picker ————
//
// The Settings card lets the user pick one of the models already configured for
// this install instead of typing provider/model ids. The catalog comes from the
// harness itself (`remote.session.modelCatalog()`), and these helpers turn its
// provider-grouped payload into `<select>` options plus the opaque value the
// select carries for one provider/model pair.

/**
 * Fold a provider/model pair into one opaque picker value.
 * Unit Separator (U+001F) cannot appear in a route id, and unlike NUL it
 * survives HTML attribute parsing.
 */
export const ROUTE_SEPARATOR = '\u001f'

/** `provider` + `model` -> one picker value, or '' when either side is empty. */
export function routeValue(provider, model) {
	if (typeof provider !== 'string' || provider === '') return ''
	if (typeof model !== 'string' || model === '') return ''
	return `${provider}${ROUTE_SEPARATOR}${model}`
}

/** A picker value back to `{ provider, model }`; '' and garbage return null. */
export function parseRouteValue(value) {
	if (typeof value !== 'string' || value === '') return null
	const at = value.indexOf(ROUTE_SEPARATOR)
	if (at <= 0 || at === value.length - 1) return null
	return { provider: value.slice(0, at), model: value.slice(at + 1) }
}

/**
 * Flatten a `session.modelCatalog()` payload into picker groups.
 *
 * One entry per provider with at least one model, in catalog order:
 * `[{ provider, name, options: [{ provider, model, label, value }] }]`.
 * Malformed payloads yield `[]` instead of throwing, because the picker must
 * still render when the host answers with an error shape.
 */
export function modelRouteGroups(value) {
	const groups = Array.isArray(value?.groups) ? value.groups : []
	const out = []
	for (const group of groups) {
		if (group === null || typeof group !== 'object') continue
		const provider = typeof group.id === 'string' ? group.id : ''
		if (provider === '') continue
		const name = typeof group.name === 'string' && group.name !== '' ? group.name : provider
		const options = []
		for (const model of Array.isArray(group.models) ? group.models : []) {
			if (model === null || typeof model !== 'object') continue
			const id = typeof model.id === 'string' ? model.id : ''
			if (id === '') continue
			const label = typeof model.name === 'string' && model.name !== '' ? model.name : id
			options.push({ provider, model: id, label, value: routeValue(provider, id) })
		}
		if (options.length === 0) continue
		out.push({ provider, name, options })
	}
	return out
}

/** Every option of every group, in catalog order. */
export function modelRouteOptions(value) {
	return modelRouteGroups(value).flatMap((group) => group.options)
}
