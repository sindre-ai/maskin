import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same mocking envelope as invoke.test.ts: no transport, filesystem or upstream.
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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createInvokeTool } from '../index'

const sessionWs = '00000000-0000-0000-0000-0000000000aa'
const foreignWs = '00000000-0000-0000-0000-0000000000bb'
const objectId = '00000000-0000-0000-0000-0000000000cc'

const baseConfig = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey',
	defaultWorkspaceId: sessionWs,
	webAppBaseUrl: 'https://maskin.io',
	telemetrySink: () => {},
}

const sessionConfig = {
	...baseConfig,
	transport: 'http' as const,
	maskinSessionId: '00000000-0000-0000-0000-0000000000dd',
}

const ctx = { actorId: 'test-actor', workspaceId: sessionWs }

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(McpServer).mockImplementation(
		() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
	)
})

afterEach(() => {
	vi.restoreAllMocks()
})

function stubFetch(payload: unknown) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
		return {
			ok: true,
			status: 200,
			headers: new Headers(),
			text: () => Promise.resolve(JSON.stringify(payload)),
			json: () => Promise.resolve(payload),
		} as Response
	})
}

describe('agent session writes stay in the session workspace', () => {
	it('refuses a write naming another workspace, error names both, nothing is sent', async () => {
		const fetchSpy = stubFetch({})
		const invoke = createInvokeTool(sessionConfig)

		const call = invoke('delete_object', { id: objectId, workspace_id: foreignWs }, ctx)

		await expect(call).rejects.toThrow(foreignWs)
		await expect(call).rejects.toThrow(sessionWs)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('treats any tool outside the read-only set as a write', async () => {
		const fetchSpy = stubFetch({})
		const invoke = createInvokeTool(sessionConfig)

		const args = { entity_id: objectId, content: 'hi', workspace_id: foreignWs }

		await expect(invoke('create_comment', args, ctx)).rejects.toThrow(
			/Agents can only write to the workspace they run in/,
		)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('allows a write that passes the session workspace id', async () => {
		const fetchSpy = stubFetch({ success: true })
		const invoke = createInvokeTool(sessionConfig)

		await invoke('delete_object', { id: objectId, workspace_id: sessionWs }, ctx)

		expect(fetchSpy).toHaveBeenCalled()
	})

	it('allows a write that omits workspace_id', async () => {
		const fetchSpy = stubFetch({ success: true })
		const invoke = createInvokeTool(sessionConfig)

		await invoke('delete_object', { id: objectId }, ctx)

		expect(fetchSpy).toHaveBeenCalled()
	})

	it('still lets a read name another workspace', async () => {
		const fetchSpy = stubFetch([])
		const invoke = createInvokeTool(sessionConfig)

		const response = await invoke('search_objects', { q: 'x', workspace_id: foreignWs }, ctx)

		expect(response).toHaveProperty('content')
		expect(fetchSpy).toHaveBeenCalled()
	})

	it('does not restrict calls made outside a session', async () => {
		const fetchSpy = stubFetch({ success: true })
		const invoke = createInvokeTool({ ...baseConfig, transport: 'http' })

		await invoke('delete_object', { id: objectId, workspace_id: foreignWs }, ctx)

		expect(fetchSpy).toHaveBeenCalled()
	})
})
