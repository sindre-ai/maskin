import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same mocking envelope as cursor-pagination.test.ts / server.test.ts: stub
// the SDK + ext-apps + node:fs so `createInvokeTool(config)` wires the tool
// registrations without any transport, filesystem or upstream side effects.
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
import { UnknownToolError, createInvokeTool } from '../index'
import { getServerHandlers } from '../server'

const wsId = '00000000-0000-0000-0000-0000000000aa'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey',
	defaultWorkspaceId: wsId,
	webAppBaseUrl: 'https://maskin.io',
	telemetrySink: () => {},
}

// Every registered tool from server.ts goes through the wrapped
// registerAppTool inside `createMcpServer`, which also pushes into the
// per-server handler map that `getServerHandlers` and `createInvokeTool`
// read from. Freshly created per test — no cross-case leakage.
beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(McpServer).mockImplementation(
		() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
	)
})

afterEach(() => {
	vi.restoreAllMocks()
})

function stubFetch(payload: unknown, status = 200) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: new Headers(),
			text: () => Promise.resolve(JSON.stringify(payload)),
			json: () => Promise.resolve(payload),
		} as Response
	})
}

describe('createInvokeTool', () => {
	it('returns a callable that dispatches a known tool via the same wrapped handler stdio gets', async () => {
		// Fixture matches the `/api/objects/search` payload shape the
		// search_objects tool expects.
		stubFetch([])
		const invoke = createInvokeTool(config)

		const response = await invoke(
			'search_objects',
			{ q: 'test' },
			{ actorId: 'test-actor', workspaceId: wsId },
		)

		// The stdio path returns `{ content, structuredContent, _meta }` for
		// every registered tool — assert the same top-level shape here so a
		// future divergence between transport-less dispatch and stdio would
		// fail this case. Some tools omit `structuredContent`; `content` is
		// the invariant.
		expect(response).toBeDefined()
		expect(response).toHaveProperty('content')
	})

	it('routes the invocation to the exact wrapped handler getServerHandlers exposes', async () => {
		stubFetch([])
		const invoke = createInvokeTool(config)

		// Build a second server against the same config to grab its handler
		// map, and prove `invoke('search_objects', ...)` and the raw handler
		// produce the same response shape (arguments identical). Same-config
		// dispatches must not diverge across transports.
		const { createMcpServer } = await import('../server')
		const server = createMcpServer(config)
		const handlers = getServerHandlers(server)
		const raw = handlers.get('search_objects')
		expect(raw).toBeDefined()

		if (!raw) throw new Error('search_objects not registered')
		const [viaInvoke, viaHandler] = await Promise.all([
			invoke('search_objects', { q: 'test' }, { actorId: 'test-actor', workspaceId: wsId }),
			raw({ q: 'test' }, { actorId: 'test-actor', workspaceId: wsId }),
		])
		expect(Object.keys(viaInvoke as object).sort()).toEqual(
			Object.keys(viaHandler as object).sort(),
		)
	})

	it('throws UnknownToolError for a name the registry does not carry', async () => {
		const invoke = createInvokeTool(config)
		await expect(
			invoke('nonexistent_tool_name', {}, { actorId: 'a', workspaceId: wsId }),
		).rejects.toBeInstanceOf(UnknownToolError)
	})

	it('exposes the missing name on the UnknownToolError so callers can log it', async () => {
		const invoke = createInvokeTool(config)
		try {
			await invoke('does_not_exist', {}, { actorId: 'a', workspaceId: wsId })
			throw new Error('should have thrown')
		} catch (err) {
			expect(err).toBeInstanceOf(UnknownToolError)
			expect((err as UnknownToolError).toolName).toBe('does_not_exist')
			expect((err as UnknownToolError).name).toBe('UnknownToolError')
		}
	})
})
