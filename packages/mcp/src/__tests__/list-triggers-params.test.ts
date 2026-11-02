import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AliasHarness, startAliasHarness } from './helpers/alias-harness'

// Importing ../server runs its stdio entry point, which would listen on this
// process's stdin. The harness builds its own server and talks over an
// in-memory transport, so the stdio one is replaced with an inert stand-in.
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
	StdioServerTransport: class {
		onmessage?: unknown
		onclose?: unknown
		onerror?: unknown
		async start() {}
		async send() {}
		async close() {}
	},
}))

const AGENT = '11111111-1111-4111-8111-111111111111'

// A real client against a real server: the unknown-parameter error has to come
// out of the SDK's own argument check, which a handler-level mock never reaches.
describe('list_triggers parameters over the real MCP transport', () => {
	let harness: AliasHarness

	beforeAll(async () => {
		harness = await startAliasHarness({ respond: () => [] })
	})

	afterAll(async () => {
		await harness.close()
	})

	it('rejects an unknown parameter by name and never calls the API', async () => {
		const outcome = await harness.call('list_triggers', { driver_id: AGENT })
		expect(outcome.isError).toBe(true)
		expect(outcome.text).toContain('driver_id')
		expect(outcome.requests).toEqual([])
	})

	it('lists the filters in the tool schema', async () => {
		const tool = (await harness.listTools()).find((t) => t.name === 'list_triggers')
		const schema = tool?.inputSchema as { properties: Record<string, unknown> }
		expect(Object.keys(schema.properties).sort()).toEqual(
			['agent_id', 'compact', 'cursor', 'limit', 'q', 'status', 'workspace_id'].sort(),
		)
	})

	it('accepts the filters and forwards them to the API', async () => {
		const outcome = await harness.call('list_triggers', {
			agent_id: AGENT,
			status: 'enabled',
			q: 'sweep',
			compact: true,
		})
		expect(outcome.isError).toBe(false)
		const [request] = outcome.requests.filter((r) => r.path.startsWith('/api/triggers'))
		const params = new URL(request.path, 'http://x').searchParams
		expect(params.get('target_actor_id')).toBe(AGENT)
		expect(params.get('enabled')).toBe('true')
		expect(params.get('q')).toBe('sweep')
	})
})
