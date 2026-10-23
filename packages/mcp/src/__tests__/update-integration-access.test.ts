import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpServer } from '../server'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
	telemetrySink: () => {},
}

type ToolResult = { content: Array<{ text: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

const jsonResponse = (body: unknown): Response =>
	({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response

const errorResponse = (status: number, message: string): Response =>
	({
		ok: false,
		status,
		text: () => Promise.resolve(JSON.stringify({ error: { code: 'ERR', message } })),
	}) as Response

const INTEGRATION = '33333333-3333-4333-8333-333333333333'
const AGENT_A = '44444444-4444-4444-8444-444444444444'
const AGENT_B = '55555555-5555-4555-8555-555555555555'

describe('update_integration_access', () => {
	let handler: Handler
	let fetchMock: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			if (name === 'update_integration_access') handler = h as Handler
		})
		fetchMock = vi.spyOn(globalThis, 'fetch')
		createMcpServer(config)
	})

	afterEach(() => vi.restoreAllMocks())

	const calls = () =>
		fetchMock.mock.calls.map(([url, init]) => {
			const req = init as RequestInit
			return [
				req.method,
				String(url).replace(config.apiBaseUrl, ''),
				req.body ? JSON.parse(String(req.body)) : undefined,
			]
		})

	it('uses the same endpoints as the Integrations page: default, per-agent grant, removal', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}))
		const result = await handler({
			integration_id: INTEGRATION,
			default_agent_access: 'none',
			agent_access: [
				{ agent_id: AGENT_A, access: 'read_write' },
				{ agent_id: AGENT_B, access: 'default' },
			],
		})
		expect(calls()).toEqual([
			['PUT', `/api/integrations/${INTEGRATION}/default-access`, { defaultAgentAccess: 'none' }],
			['PUT', `/api/integrations/${INTEGRATION}/grants/${AGENT_A}`, { access: 'read_write' }],
			['DELETE', `/api/integrations/${INTEGRATION}/grants/${AGENT_B}`, undefined],
		])
		expect(result.isError).toBeUndefined()
		expect(result.content[0]?.text).toContain('Applied')
	})

	it('reports a refusal (an agent caller) as an error, with nothing applied', async () => {
		fetchMock.mockResolvedValue(errorResponse(403, 'Only a person can change agent access'))
		const result = await handler({
			integration_id: INTEGRATION,
			agent_access: [{ agent_id: AGENT_A, access: 'read' }],
		})
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('Only a person can change agent access')
	})

	it('applies what it can and names what failed', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({}))
			.mockResolvedValueOnce(errorResponse(400, 'That actor is not an agent in this workspace'))
		const result = await handler({
			integration_id: INTEGRATION,
			agent_access: [
				{ agent_id: AGENT_A, access: 'read' },
				{ agent_id: AGENT_B, access: 'read' },
			],
		})
		expect(result.isError).toBeUndefined()
		expect(result.content[0]?.text).toContain('Applied')
		expect(result.content[0]?.text).toContain('Failed')
	})
})
