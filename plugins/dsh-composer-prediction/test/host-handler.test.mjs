// Host RPC surface: exercised with dependency injection and a stubbed fetch.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createHandler, resolveApiKey } from '../lib/handler.js'
import { DEFAULT_CONFIG, toApiMessages } from '../lib/shared.js'

const CONFIG = { ...DEFAULT_CONFIG, model: 'deepseek-flash', apiKey: 'sk-test', baseUrl: 'https://api.example/v1' }

const context = (overrides, extra) => {
	const state = { config: { ...CONFIG, ...overrides }, updates: [] }
	const handler = createHandler({
		getConfig: () => ({ ...state.config }),
		updateConfig: async (patch) => {
			state.updates.push(patch)
			state.config = { ...state.config, ...patch }
		},
		inflight: new Map(),
		...(extra ?? {}),
	})
	return { handler, state }
}

/** Minimal ctx.llm stand-in that streams a fixed answer and records controls. */
const fakeLlm = (answer = 'Run the tests.') => {
	const seen = []
	return {
		seen,
		llm: {
			async prepareCall(config, signal, configure) {
				seen.push({ config })
				const controls = configure({ ...config }, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
				seen.push({ controls })
				return {
					config: { ...config, ...controls },
					async *stream(options) {
						seen.push({ options })
						for (const piece of answer.split(' ')) {
							yield { type: 'text-delta', index: 0, text: `${piece} ` }
						}
					},
				}
			},
		},
	}
}

const MESSAGES = [
	{ role: 'user', content: 'the parser drops empty lines' },
	{ role: 'assistant', content: 'Fixed in lib/parser.ts.' },
]

test('config.get returns the effective config', async () => {
	const { handler, state } = context()
	const result = await handler('config.get', {})
	assert.equal(result.ok, true)
	assert.equal(result.value.model, state.config.model)
})

test('config.set sanitizes the patch before persisting', async () => {
	const { handler, state } = context()
	const result = await handler('config.set', { maxTokens: 9000, delayMs: -1, bogus: true, enabled: false })
	assert.equal(result.ok, true)
	assert.deepEqual(state.updates, [{ maxTokens: 2048, delayMs: 0, enabled: false }])
	assert.equal(result.value.enabled, false)
})

test('predict mirrors one normalized suggestion', async () => {
	const { handler } = context()
	let seen = null
	globalThis.fetch = async (url, init) => {
		seen = { url, body: JSON.parse(init.body), headers: init.headers }
		return { ok: true, json: async () => ({ choices: [{ message: { content: '"Add a regression test for empty input."' } }] }) }
	}
	const result = await handler('predict', { requestId: 'r1', messages: MESSAGES })
	assert.equal(result.ok, true)
	assert.equal(result.value.text, 'Add a regression test for empty input.')
	assert.equal(seen.url, 'https://api.example/v1/chat/completions')
	assert.equal(seen.headers.authorization, 'Bearer sk-test')
	assert.equal(seen.body.model, CONFIG.model)
	assert.equal(seen.body.stream, false)
	assert.equal(seen.body.messages.length, 2)
	assert.equal(seen.body.messages[0].role, 'system')
	assert.match(seen.body.messages[1].content, /Assistant: Fixed in lib\/parser\.ts\./)
})

test('predict never offers an explicit refusal or assistant voice', async () => {
	for (const content of ['NONE', 'Sure, I updated the parser.']) {
		const { handler } = context()
		globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })
		const result = await handler('predict', { messages: MESSAGES })
		assert.equal(result.ok, true)
		assert.equal(result.value.text, '')
	}
})

test('predict without a model route or key fails loudly instead of silently', async () => {
	let calls = 0
	globalThis.fetch = async () => {
		calls += 1
		return { ok: true, json: async () => ({}) }
	}

	const noKey = context({ apiKey: '' })
	const saved = process.env.DEEPSEEK_API_KEY
	const savedHome = process.env.DSH_HOME
	process.env.DEEPSEEK_API_KEY = ''
	process.env.DSH_HOME = 'C:/definitely/not/here'
	const missing = await noKey.handler('predict', { messages: MESSAGES })
	if (saved === undefined) delete process.env.DEEPSEEK_API_KEY
	else process.env.DEEPSEEK_API_KEY = saved
	if (savedHome === undefined) delete process.env.DSH_HOME
	else process.env.DSH_HOME = savedHome
	assert.equal(missing.ok, false)
	assert.match(missing.error.message, /no model route/)

	const empty = await noKey.handler('predict', { messages: [] })
	assert.equal(empty.value.reason, 'empty-context')
	assert.equal(calls, 0)
})

test('predict rides ctx.llm with the deployment default route and the model default effort', async () => {
	const fake = fakeLlm('Run the integration tests.')
	const { handler } = context(
		{ apiKey: '', model: '', provider: '' },
		{ llm: fake.llm, defaultSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
	)
	globalThis.fetch = async () => {
		throw new Error('ctx.llm path must not call fetch')
	}

	const result = await handler('predict', { messages: MESSAGES })
	assert.equal(result.ok, true)
	assert.equal(result.value.text, 'Run the integration tests.')
	assert.equal(result.value.provider, 'deepseek-account')
	assert.equal(result.value.model, 'deepseek-flash')

	const controls = fake.seen.find((entry) => entry.controls !== undefined).controls
	assert.equal(controls.reasoningEffort, undefined, 'auto must leave the model default alone')
	const options = fake.seen.find((entry) => entry.options !== undefined).options
	assert.equal(options.system.includes('composer autocomplete'), true)
	assert.equal(options.messages.length, 1)
	assert.equal(options.messages[0].content[0].type, 'text')
	assert.equal(options.maxTokens, 512)
})

test('explicit provider/model settings win over the deployment default', async () => {
	const fake = fakeLlm('Ship it.')
	const { handler } = context(
		{ provider: 'kimi-code', model: 'kimi-k2' },
		{ llm: fake.llm, defaultSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
	)
	const result = await handler('predict', { messages: MESSAGES })
	assert.equal(result.value.provider, 'kimi-code')
	assert.equal(result.value.model, 'kimi-k2')
})

test('predict is a no-op while the feature is disabled', async () => {
	const { handler } = context({ enabled: false })
	const result = await handler('predict', { messages: MESSAGES })
	assert.equal(result.ok, true)
	assert.equal(result.value.reason, 'disabled')
})

test('provider failures surface as RPC errors, not suggestions', async () => {
	const { handler } = context()
	globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
	const result = await handler('predict', { messages: MESSAGES })
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'internal')
	assert.match(result.error.message, /401/)
})

test('cancel aborts the matching in-flight prediction only', async () => {
	const { handler } = context()
	globalThis.fetch = (url, init) =>
		new Promise((resolve, reject) => {
			init.signal.addEventListener('abort', () => reject(new Error('aborted')))
		})

	const unknown = await handler('cancel', { requestId: 'nope' })
	assert.deepEqual(unknown.value, { cancelled: false })

	const pending = handler('predict', { requestId: 'r9', messages: MESSAGES })
	await new Promise((resolve) => setTimeout(resolve, 10))
	const cancelled = await handler('cancel', { requestId: 'r9' })
	assert.deepEqual(cancelled.value, { cancelled: true })
	const result = await pending
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'cancelled')
})

test('unknown endpoints and malformed cancel are rejected', async () => {
	const { handler } = context()
	const unknown = await handler('nope', {})
	assert.equal(unknown.ok, false)
	const cancel = await handler('cancel', {})
	assert.equal(cancel.ok, false)
})

test('resolveApiKey prefers the setting, then the environment', () => {
	assert.equal(resolveApiKey({ apiKey: 'sk-config' }), 'sk-config')
	const saved = process.env.DEEPSEEK_API_KEY
	process.env.DEEPSEEK_API_KEY = 'sk-env'
	assert.equal(resolveApiKey({ apiKey: '' }), 'sk-env')
	if (saved === undefined) delete process.env.DEEPSEEK_API_KEY
	else process.env.DEEPSEEK_API_KEY = saved
})

test('the request the host sends is the one the shared builder describes', () => {
	const messages = toApiMessages(MESSAGES)
	assert.equal(messages.length, 2)
	assert.match(messages[1].content, /Write the developer's next message/)
})

// ———— config.routes: the Settings model picker ————

const routeLlm = (failFor = []) => {
	const listed = []
	return {
		listed,
		llm: {
			listProviders: () => [
				{ id: 'deepseek', name: 'DeepSeek' },
				{ id: 'moonshot', name: 'Kimi' },
			],
			async listModels(provider) {
				listed.push(provider)
				if (failFor.includes(provider)) throw new Error(`${provider} unreachable`)
				if (provider === 'deepseek') {
					return [
						{ provider, id: 'deepseek-chat', name: 'DeepSeek Chat' },
						{ provider, id: 'deepseek-flash', name: 'DeepSeek Flash' },
					]
				}
				return [{ provider, id: 'kimi-k2', name: 'Kimi K2' }]
			},
		},
	}
}

test('config.routes lists configured providers with their models', async () => {
	const stub = routeLlm()
	const { handler } = context({}, { llm: stub.llm, defaultSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) })
	const result = await handler('config.routes', {})
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.groups.map((group) => group.id), ['deepseek', 'moonshot'])
	assert.deepEqual(result.value.groups[0].models, [
		{ id: 'deepseek-chat', name: 'DeepSeek Chat' },
		{ id: 'deepseek-flash', name: 'DeepSeek Flash' },
	])
	assert.deepEqual(result.value.default, { provider: 'deepseek', model: 'deepseek-chat' })
	assert.deepEqual(result.value.failures, [])
})

test('config.routes reports one failing provider without losing the rest', async () => {
	const stub = routeLlm(['moonshot'])
	const { handler } = context({}, { llm: stub.llm, defaultSelection: () => undefined })
	const result = await handler('config.routes', {})
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.groups.map((group) => group.id), ['deepseek'])
	assert.equal(result.value.failures.length, 1)
	assert.equal(result.value.failures[0].id, 'moonshot')
	assert.match(result.value.failures[0].message, /unreachable/)
	assert.equal(result.value.default, null)
})

test('config.routes degrades when no LLM service is composed', async () => {
	const { handler } = context({})
	const result = await handler('config.routes', {})
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.groups, [])
	assert.equal(result.value.failures[0].message, 'no harness LLM service')
})

test('config.routes caches and honours an explicit refresh', async () => {
	const stub = routeLlm()
	const { handler } = context({}, { llm: stub.llm })
	await handler('config.routes', {})
	await handler('config.routes', {})
	assert.deepEqual(stub.listed, ['deepseek', 'moonshot'])
	stub.listed.length = 0
	const refreshed = await handler('config.routes', { refresh: true })
	assert.equal(refreshed.ok, true)
	assert.deepEqual(stub.listed, ['deepseek', 'moonshot'])
})

// ———— prediction v2: effort policy, candidates, style memory ————

test('reasoningEffort cheapest still pins the cheapest advertised effort', async () => {
	const fake = fakeLlm('Continue.')
	const { handler } = context({ apiKey: '', provider: '', model: '', reasoningEffort: 'cheapest' }, { llm: fake.llm, defaultSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) })
	globalThis.fetch = async () => {
		throw new Error('ctx.llm path must not call fetch')
	}
	await handler('predict', { messages: MESSAGES })
	const controls = fake.seen.find((entry) => entry.controls !== undefined).controls
	assert.equal(controls.reasoningEffort, 'low')
})

test('an explicit advertised effort id is honoured, an unknown one is ignored', async () => {
	for (const [preference, expected] of [
		['high', 'high'],
		['nope', undefined],
	]) {
		const fake = fakeLlm('Continue.')
		const { handler } = context({ apiKey: '', provider: '', model: '', reasoningEffort: preference }, { llm: fake.llm, defaultSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) })
		await handler('predict', { messages: MESSAGES })
		const controls = fake.seen.find((entry) => entry.controls !== undefined).controls
		assert.equal(controls.reasoningEffort, expected)
	}
})

test('predict returns every ranked candidate, not just the first', async () => {
	const fake = fakeLlm('Run the tests.\nCommit this.\nExplain the diff.')
	const { handler } = context({ apiKey: '', provider: '', model: '' }, { llm: fake.llm, defaultSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) })
	globalThis.fetch = async () => {
		throw new Error('ctx.llm path must not call fetch')
	}
	const result = await handler('predict', { messages: MESSAGES })
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.suggestions, ['Run the tests.', 'Commit this.', 'Explain the diff.'])
	assert.equal(result.value.text, 'Run the tests.')
})

test('accepted remembers the custom line as a style sample, bounded and deduped', async () => {
	const { handler, state } = context({}, {})
	assert.equal((await handler('accepted', {})).ok, false)
	const first = await handler('accepted', { text: '跑一下测试' })
	assert.deepEqual(first.value.styleSamples, ['跑一下测试'])
	await handler('accepted', { text: '跑一下测试' })
	assert.deepEqual(state.config.styleSamples, ['跑一下测试'], 'the same line must not be stored twice')
	for (let i = 0; i < 10; i += 1) await handler('accepted', { text: `line ${i}` })
	assert.equal(state.config.styleSamples.length, 8)
	assert.equal(state.config.styleSamples.at(-1), 'line 9')
})
