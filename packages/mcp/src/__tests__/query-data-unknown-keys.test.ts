import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same wiring as batch-write-input.test.ts: the real createMcpServer with the SDK mocked, then the
// schema the server registered is run over the raw arguments, the way the SDK does before it calls
// the handler.
vi.mock('@modelcontextprotocol/ext-apps/server', () => ({
	registerAppTool: vi.fn(),
	registerAppResource: vi.fn(),
	RESOURCE_MIME_TYPE: 'text/html',
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
	McpServer: vi.fn().mockImplementation(() => ({ registerResource: vi.fn(), connect: vi.fn() })),
	ResourceTemplate: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('node:fs', () => ({
	readFileSync: vi.fn().mockReturnValue('<html>mock</html>'),
}))

import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { createMcpServer } from '../server'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
	telemetrySink: () => {},
}

type ParseOutcome =
	| { success: true; data: unknown }
	| { success: false; error: { message: string } }

// The schema error is a JSON list of issues; the agent reads the issue message.
const messageOf = (out: ParseOutcome) =>
	out.success ? '' : (JSON.parse(out.error.message) as Array<{ message: string }>)[0].message

describe('query_data unknown argument names', () => {
	let schema: { safeParse: (raw: unknown) => ParseOutcome }

	beforeEach(() => {
		vi.mocked(registerAppTool).mockImplementation((_server, name, def) => {
			if (name === 'query_data') schema = (def as { inputSchema: never }).inputSchema
		})
		createMcpServer(config)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('refuses a key it does not know, names it, and shows a correct call', () => {
		const out = schema.safeParse({ type: 'task', filter: { status: 'done' } })
		expect(out.success).toBe(false)
		const message = messageOf(out)
		expect(message).toContain('Unrecognised argument name: filter')
		expect(message).toContain('Accepted names: workspace_id, scope, type, filters')
		expect(message).toContain('Example: query_data({ type: "task"')
		expect(message).not.toContain('Nothing was written')
	})

	it('names every unknown key when there are several', () => {
		const out = schema.safeParse({ type: 'task', sql: 'select 1', group: 'status' })
		expect(out.success).toBe(false)
		expect(out.success ? '' : out.error.message).toContain(
			'Unrecognised argument names: sql, group',
		)
	})

	it('still accepts a call that uses only known keys', () => {
		const out = schema.safeParse({
			type: 'task',
			filters: { status: 'done' },
			group_by: 'status',
			limit: 10,
		})
		expect(out.success).toBe(true)
	})
})
