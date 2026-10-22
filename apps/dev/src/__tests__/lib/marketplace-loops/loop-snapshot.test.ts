import { describe, expect, it } from 'vitest'
import { actorSnapshot, dropLegacyBrowserFlag } from '../../../lib/marketplace-loops/loop-snapshot'

const baseRow = {
	type: 'agent',
	name: 'Event Producer',
	description: null,
	systemPrompt: 'You run meetups.',
	llmProvider: 'anthropic',
	llmConfig: null,
}

const browserServer = {
	type: 'stdio',
	command: 'npx',
	args: ['@playwright/mcp@latest', '--cdp-endpoint', '${BROWSER_CDP_URL}'],
}

describe('actorSnapshot', () => {
	it('drops mcpServers so publisher secrets never reach the snapshot', () => {
		const out = actorSnapshot({
			...baseRow,
			tools: {
				mcpServers: { hubspot: { command: 'npx', env: { HUBSPOT_TOKEN: 'pat-live-secret' } } },
			},
		})
		expect(JSON.stringify(out)).not.toContain('pat-live-secret')
		expect(out.tools).toEqual({})
	})

	it('drops a browser MCP entry along with the rest of mcpServers, leaving no browser flag', () => {
		const out = actorSnapshot({
			...baseRow,
			tools: {
				mcpServers: {
					playwright: browserServer,
					hubspot: { command: 'npx', env: { HUBSPOT_TOKEN: 'pat-live-secret' } },
				},
			},
		})
		// The agent's computer replaces the browser sidecar, so no capability flag remains.
		expect(out.tools).toEqual({})
		expect(JSON.stringify(out)).not.toContain('pat-live-secret')
	})

	it('leaves non-object tools untouched', () => {
		expect(actorSnapshot({ ...baseRow, tools: null }).tools).toBeNull()
	})
})

describe('actorSnapshot llmConfig', () => {
	it('drops apiKey so a provider credential never reaches the snapshot', () => {
		const out = actorSnapshot({
			...baseRow,
			tools: null,
			llmConfig: { provider: 'anthropic', model: 'fake-model', apiKey: 'fake-key-not-real' },
		})
		expect(JSON.stringify(out)).not.toContain('fake-key-not-real')
		expect(out.llmConfig).not.toHaveProperty('apiKey')
	})

	it('drops snake_case and nested credential keys too', () => {
		const out = actorSnapshot({
			...baseRow,
			tools: null,
			llmConfig: {
				provider: 'custom',
				api_key: 'fake-snake-key',
				headers: { Authorization: 'Bearer fake-bearer' },
			},
		})
		expect(JSON.stringify(out)).not.toContain('fake-snake-key')
		expect(JSON.stringify(out)).not.toContain('fake-bearer')
	})

	it('drops unknown keys, endpoints and headers by default', () => {
		const out = actorSnapshot({
			...baseRow,
			tools: null,
			llmConfig: {
				provider: 'custom',
				model: 'fake-model',
				baseUrl: 'https://fake-gateway.invalid',
				someFutureSetting: 'x',
			},
		})
		expect(out.llmConfig).toEqual({ provider: 'custom', model: 'fake-model' })
	})

	it('keeps provider and model unchanged', () => {
		const out = actorSnapshot({
			...baseRow,
			tools: null,
			llmConfig: { provider: 'anthropic', model: 'fake-model' },
		})
		expect(out.llmConfig).toEqual({ provider: 'anthropic', model: 'fake-model' })
	})

	it('keeps only the model when the config has no provider', () => {
		const out = actorSnapshot({ ...baseRow, tools: null, llmConfig: { model: 'fake-model' } })
		expect(out.llmConfig).toEqual({ model: 'fake-model' })
	})

	it('does not throw on a null, missing or non-object llmConfig', () => {
		expect(actorSnapshot({ ...baseRow, tools: null, llmConfig: null }).llmConfig).toBeNull()
		expect(actorSnapshot({ ...baseRow, tools: null, llmConfig: undefined }).llmConfig).toBeNull()
		expect(actorSnapshot({ ...baseRow, tools: null, llmConfig: 'fake-key' }).llmConfig).toBeNull()
		expect(actorSnapshot({ ...baseRow, tools: null, llmConfig: ['fake-key'] }).llmConfig).toBeNull()
	})

	it('keeps an empty llmConfig empty', () => {
		expect(actorSnapshot({ ...baseRow, tools: null, llmConfig: {} }).llmConfig).toEqual({})
	})
})

describe('dropLegacyBrowserFlag', () => {
	it('removes the flag older snapshots carry and keeps everything else', () => {
		expect(dropLegacyBrowserFlag({ browser: true, other: 1 })).toEqual({ other: 1 })
		expect(dropLegacyBrowserFlag({ browser: true })).toEqual({})
	})

	it('is a no-op without the flag', () => {
		const tools = { mcpServers: { hubspot: { command: 'npx' } } }
		expect(dropLegacyBrowserFlag(tools)).toEqual(tools)
		expect(dropLegacyBrowserFlag(null)).toBeNull()
	})
})
