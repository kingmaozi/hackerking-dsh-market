import assert from 'node:assert/strict'
import test from 'node:test'

import {
	DEFAULT_CONFIG,
	clampFloat,
	clampNumber,
	extractTail,
	lastAssistantSeq,
	buildSystemPrompt,
	modelRouteGroups,
	modelRouteOptions,
	normalizeSuggestion,
	normalizeSuggestions,
	parseRouteValue,
	routeValue,
	sanitizeConfigPatch,
	toApiMessages,
} from '../lib/shared.js'

const user = (text, seq = 1) => ({ kind: 'user', seq, content: [{ kind: 'text', text }] })
const assistant = (text, seq = 2) => ({ kind: 'assistant', seq, blocks: [{ kind: 'text', text }] })

test('normalizeSuggestion strips quoting and speaker labels', () => {
	assert.equal(normalizeSuggestion('"Add a regression test for this fix."'), 'Add a regression test for this fix.')
	assert.equal(normalizeSuggestion('Next: run the suite'), 'run the suite')
	assert.equal(normalizeSuggestion('`fix the flaky test`'), 'fix the flaky test')
	assert.equal(normalizeSuggestion('\u201cCan you also update the docs?\u201d'), 'Can you also update the docs?')
})

test('normalizeSuggestion keeps only the first non-empty line', () => {
	assert.equal(normalizeSuggestion('\n\n  ship it  \nand then some'), 'ship it')
})

test('normalizeSuggestion refuses explicit non-answers and assistant voice', () => {
	assert.equal(normalizeSuggestion('NONE'), '')
	assert.equal(normalizeSuggestion('none.'), '')
	assert.equal(normalizeSuggestion('Sure, I can do that'), '')
	assert.equal(normalizeSuggestion("Here's the updated file"), '')
	assert.equal(normalizeSuggestion('   '), '')
	assert.equal(normalizeSuggestion(null), '')
})

test('normalizeSuggestion truncates on a word boundary', () => {
	const long = 'please '.repeat(60).trim()
	const out = normalizeSuggestion(long, { maxChars: 40 })
	assert.ok(out.length <= 40)
	assert.ok(!out.endsWith(' '))
	assert.ok(!out.endsWith(','))
})

test('extractTail keeps chronological user/assistant turns and drops noise', () => {
	const nodes = [
		user('first question', 1),
		assistant('first answer', 2),
		{ kind: 'tool-result', seq: 3 },
		{ kind: 'context', seq: 4, content: [{ kind: 'text', text: 'system noise' }] },
		user('second question', 5),
		assistant('second answer', 6),
	]
	assert.deepEqual(extractTail(nodes), [
		{ role: 'user', content: 'first question' },
		{ role: 'assistant', content: 'first answer' },
		{ role: 'user', content: 'second question' },
		{ role: 'assistant', content: 'second answer' },
	])
})

test('extractTail honours the message limit and the character budget', () => {
	const nodes = [user('a'.repeat(500), 1), assistant('b'.repeat(500), 2), user('recent', 3)]
	const limited = extractTail(nodes, { limit: 2 })
	assert.equal(limited.length, 2)
	assert.equal(limited[1].content, 'recent')

	const budgeted = extractTail(nodes, { limit: 10, maxChars: 600 })
	const total = budgeted.reduce((sum, message) => sum + message.content.length, 0)
	assert.ok(total <= 600)
})

test('extractTail joins only text blocks', () => {
	const node = {
		kind: 'assistant',
		seq: 9,
		blocks: [
			{ kind: 'reasoning', text: 'thinking' },
			{ kind: 'text', text: 'answer' },
			{ kind: 'tool-call', callId: 'x', name: 'read', argsRaw: '{}' },
		],
	}
	assert.deepEqual(extractTail([node]), [{ role: 'assistant', content: 'answer' }])
})

test('lastAssistantSeq finds the newest answer', () => {
	assert.equal(lastAssistantSeq([user('q', 1), assistant('a', 2), user('q2', 3)]), 2)
	assert.equal(lastAssistantSeq([user('q', 1)]), 0)
	assert.equal(lastAssistantSeq(null), 0)
})

test('toApiMessages asks the model for the next user message', () => {
	const messages = toApiMessages([{ role: 'user', content: 'fix the bug' }, { role: 'assistant', content: 'fixed' }])
	assert.equal(messages.length, 2)
	assert.equal(messages[0].role, 'system')
	assert.match(messages[0].content, /composer autocomplete/i)
	assert.equal(messages[1].role, 'user')
	assert.match(messages[1].content, /User: fix the bug/)
	assert.match(messages[1].content, /Assistant: fixed/)
	assert.match(messages[1].content, /Write the developer's next message/)
})

test('toApiMessages rejects empty context', () => {
	assert.deepEqual(toApiMessages([]), [])
})

test('sanitizeConfigPatch clamps and drops unknown or mistyped values', () => {
	const patch = sanitizeConfigPatch({
		enabled: 'yes',
		model: '  deepseek-reasoner  ',
		maxTokens: 9999,
		delayMs: -5,
		temperature: 9,
		unknown: 'dropped',
		apiKey: 42,
	})
	assert.deepEqual(patch, {
		model: 'deepseek-reasoner',
		maxTokens: 2048,
		delayMs: 0,
		temperature: 2,
	})
})

test('clamp helpers fall back on non-finite input', () => {
	assert.equal(clampNumber('abc', 0, 10, 7), 7)
	assert.equal(clampNumber(12.6, 0, 10, 7), 10)
	assert.equal(clampFloat(0.25, 0, 2, 1), 0.25)
	assert.equal(clampFloat(undefined, 0, 2, 1), 1)
})

// ———— configured-model picker ————

const catalog = {
	default: { provider: 'deepseek', model: 'deepseek-chat' },
	routableProviders: ['deepseek'],
	groups: [
		{
			id: 'deepseek',
			name: 'DeepSeek',
			models: [
				{ id: 'deepseek-chat', name: 'DeepSeek Chat' },
				{ id: 'deepseek-flash', name: 'DeepSeek Flash' },
			],
		},
		{ id: 'moonshot', name: 'Kimi', models: [{ id: 'kimi-k2', name: 'Kimi K2' }] },
		{ id: 'empty-provider', name: 'Empty', models: [] },
	],
	failures: [],
}

test('routeValue round-trips through parseRouteValue', () => {
	const value = routeValue('deepseek', 'deepseek-chat')
	assert.equal(value, 'deepseek\u001fdeepseek-chat')
	assert.deepEqual(parseRouteValue(value), { provider: 'deepseek', model: 'deepseek-chat' })
})

test('parseRouteValue rejects the automatic entry and malformed values', () => {
	assert.equal(parseRouteValue(''), null)
	assert.equal(parseRouteValue('deepseek'), null)
	assert.equal(parseRouteValue('\u001fmodel'), null)
	assert.equal(parseRouteValue('provider\u001f'), null)
	assert.equal(parseRouteValue(undefined), null)
	assert.equal(routeValue('', 'model'), '')
	assert.equal(routeValue('provider', ''), '')
})

test('modelRouteGroups keeps catalog order, names and non-empty groups only', () => {
	const groups = modelRouteGroups(catalog)
	assert.deepEqual(groups.map((group) => group.provider), ['deepseek', 'moonshot'])
	assert.equal(groups[0].name, 'DeepSeek')
	assert.deepEqual(groups[0].options.map((option) => option.model), ['deepseek-chat', 'deepseek-flash'])
	assert.deepEqual(groups[1].options[0], {
		provider: 'moonshot',
		model: 'kimi-k2',
		label: 'Kimi K2',
		value: 'moonshot\u001fkimi-k2',
	})
})

test('modelRouteGroups falls back to ids and survives malformed payloads', () => {
	const groups = modelRouteGroups({ groups: [{ id: 'p', models: [{ id: 'm' }, null, { id: '' }] }] })
	assert.deepEqual(groups, [{ provider: 'p', name: 'p', options: [{ provider: 'p', model: 'm', label: 'm', value: 'p\u001fm' }] }])
	assert.deepEqual(modelRouteGroups(undefined), [])
	assert.deepEqual(modelRouteGroups({ groups: 'nope' }), [])
	assert.deepEqual(modelRouteGroups({ groups: [{ models: [{ id: 'm' }] }] }), [])
})

test('modelRouteOptions flattens every group in order', () => {
	assert.deepEqual(modelRouteOptions(catalog).map((option) => option.model), [
		'deepseek-chat',
		'deepseek-flash',
		'kimi-k2',
	])
})

// ———— prediction v2: candidates, prompt, sanitize ————

test('normalizeSuggestions ranks, cleans and dedupes candidate lines', () => {
	const raw = ['1. 跑一下测试', '2. "提交这个改动"', '3. 跑一下测试', 'NONE', '**解释一下为什么**', ''].join('\n')
	const out = normalizeSuggestions(raw, { candidates: 5, maxChars: 200 })
	assert.deepEqual(out, ['跑一下测试', '提交这个改动', '**解释一下为什么**'])
})

test('normalizeSuggestions honours the candidate limit and drops assistant voice', () => {
	const raw = ['Sure, I can do that', '继续', '再看日志', '跑测试', '合并'].join('\n')
	assert.deepEqual(normalizeSuggestions(raw, { candidates: 2 }), ['继续', '再看日志'])
	assert.deepEqual(normalizeSuggestions('NONE', { candidates: 3 }), [])
	assert.deepEqual(normalizeSuggestions(undefined, { candidates: 3 }), [])
	assert.equal(normalizeSuggestion('继续\n再看日志', { candidates: 3 }), '继续')
})

test('the system prompt asks for ranked alternatives and can carry style samples', () => {
	const prompt = buildSystemPrompt({ candidates: 3, styleSamples: ['继续', '跑一下测试'] })
	assert.match(prompt, /up to 3 alternative messages/)
	assert.match(prompt, /most likely first/)
	assert.match(prompt, /This developer has actually sent lines like these before/)
	assert.match(prompt, /- 继续/)
	assert.match(buildSystemPrompt({ candidates: 1 }), /up to 1 alternative message/)
	assert.doesNotMatch(buildSystemPrompt({ candidates: 1 }), /sent lines like these before/)
})

test('sanitizeConfigPatch accepts the v2 knobs and rejects bad effort ids', () => {
	const patch = sanitizeConfigPatch({
		maxTokens: 900,
		candidates: 9,
		reasoningEffort: 'high',
	})
	assert.deepEqual(patch, { maxTokens: 900, candidates: 5, reasoningEffort: 'high' })
	assert.deepEqual(sanitizeConfigPatch({ reasoningEffort: 'not a valid id!' }), {})
	assert.deepEqual(sanitizeConfigPatch({ reasoningEffort: 'cheapest' }), { reasoningEffort: 'cheapest' })
})
