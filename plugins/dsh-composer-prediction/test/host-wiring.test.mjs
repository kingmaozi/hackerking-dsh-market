// Wires the real host entry (`apply`) to a fake cordis context and drives the
// registered loopback route: this covers index.js -> handler -> ctx.llm, which
// the unit tests of createHandler cannot see.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'composer-predict-'))
process.env.DSH_HOME = home
const { apply } = await import('../lib/index.js')

const llm = {
	listProviders: () => [
		{ id: 'deepseek', name: 'DeepSeek' },
		{ id: 'moonshot', name: 'Kimi' },
	],
	async listModels(provider) {
		if (provider === 'deepseek') return [{ provider, id: 'deepseek-chat', name: 'DeepSeek Chat' }]
		throw new Error('moonshot: no credential')
	},
}

function mount() {
	let registered
	let defaultSelection = () => ({ provider: 'deepseek', model: 'deepseek-chat' })
	const ctx = {
		llm,
		get: () => undefined,
		effect: (fn) => {
			const dispose = fn()
			return typeof dispose === 'function' ? dispose : () => {}
		},
		inject: (names, callback) => {
			if (names.includes('agentDefaultModel')) {
				callback({ agentDefaultModel: { currentSelection: () => defaultSelection() } })
			}
		},
		connection: {
			fetch: {
				register: (options) => {
					registered = options
					return () => {}
				},
			},
		},
	}
	apply(ctx)
	assert.ok(registered !== undefined, 'the RPC route was never registered')
	assert.equal(registered.path, '/api/composer-predict/rpc')
	return {
		call: (endpoint, payload) =>
			registered
				.fetch({
					json: async () => ({ endpoint, payload }),
				})
				.then((response) => response.json()),
	}
}

test('config.routes answers the Settings picker through the real host wiring', async () => {
	const { call } = mount()
	const result = await call('config.routes', { refresh: true })
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.groups.map((group) => group.id), ['deepseek'])
	assert.deepEqual(result.value.groups[0].models, [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }])
	assert.equal(result.value.failures.length, 1)
	assert.equal(result.value.failures[0].id, 'moonshot')
	assert.deepEqual(result.value.default, { provider: 'deepseek', model: 'deepseek-chat' })
})

test('predict and accepted answer through the real route', async () => {
	const { call } = mount()
	const accepted = await call('accepted', { text: '跑一下测试' })
	assert.equal(accepted.ok, true)
	assert.deepEqual(accepted.value.styleSamples, ['跑一下测试'])
	const refused = await call('accepted', { text: '   ' })
	assert.equal(refused.ok, false)
})

test('existing endpoints still answer after the route was added', async () => {
	const { call } = mount()
	const config = await call('config.get', {})
	assert.equal(config.ok, true)
	assert.equal(config.value.enabled, true)
	const saved = await call('config.set', { provider: 'moonshot', model: 'kimi-k2' })
	assert.equal(saved.ok, true)
	assert.equal(saved.value.provider, 'moonshot')
	assert.equal(saved.value.model, 'kimi-k2')
})

test('teardown', () => {
	rmSync(home, { recursive: true, force: true })
})
