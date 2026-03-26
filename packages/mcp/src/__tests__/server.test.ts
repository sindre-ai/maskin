import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the MCP SDK modules
vi.mock('@modelcontextprotocol/ext-apps/server', () => ({
	registerAppTool: vi.fn(),
	registerAppResource: vi.fn(),
	RESOURCE_MIME_TYPE: 'text/html',
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
	McpServer: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('node:fs', () => ({
	readFileSync: vi.fn().mockReturnValue('<html>mock</html>'),
}))

import { registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { createMcpServer } from '../server'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
}

describe('createMcpServer', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('registers all 39 tools', () => {
		createMcpServer(config)
		expect(registerAppTool).toHaveBeenCalledTimes(39)
	})

	it('registers all 7 UI resources', () => {
		createMcpServer(config)
		expect(registerAppResource).toHaveBeenCalledTimes(7)
	})

	it('registers tools with correct names', () => {
		createMcpServer(config)
		const registeredNames = vi.mocked(registerAppTool).mock.calls.map((call) => call[1])
		expect(registeredNames).toContain('create_objects')
		expect(registeredNames).toContain('list_objects')
		expect(registeredNames).toContain('create_actor')
		expect(registeredNames).toContain('create_session')
		expect(registeredNames).toContain('run_agent')
		expect(registeredNames).toContain('create_notification')
		expect(registeredNames).toContain('create_trigger')
	})

	it('registers tools with descriptions', () => {
		createMcpServer(config)
		const toolDefs = vi.mocked(registerAppTool).mock.calls.map((call) => call[2])
		for (const def of toolDefs) {
			expect(def.description).toBeTruthy()
			expect(typeof def.description).toBe('string')
		}
	})

	it('registers tools with inputSchema shapes', () => {
		createMcpServer(config)
		const toolDefs = vi.mocked(registerAppTool).mock.calls.map((call) => call[2])
		for (const def of toolDefs) {
			expect(def.inputSchema).toBeDefined()
		}
	})

	it('registers UI resources with correct URIs', () => {
		createMcpServer(config)
		const resourceUris = vi.mocked(registerAppResource).mock.calls.map((call) => call[2])
		expect(resourceUris).toContain('ui://ai-native/objects')
		expect(resourceUris).toContain('ui://ai-native/actors')
		expect(resourceUris).toContain('ui://ai-native/workspaces')
		expect(resourceUris).toContain('ui://ai-native/events')
		expect(resourceUris).toContain('ui://ai-native/triggers')
		expect(resourceUris).toContain('ui://ai-native/relationships')
		expect(resourceUris).toContain('ui://ai-native/graph')
	})
})

describe('tool handlers', () => {
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = new Map()

		vi.mocked(registerAppTool).mockImplementation(
			(_server, name, _def, handler) => {
				handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
			},
		)

		createMcpServer(config)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function mockFetchSuccess(data: unknown) {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(data),
		} as Response)
	}

	function mockFetchError(status: number, body: string) {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: false,
			status,
			text: () => Promise.resolve(body),
		} as Response)
	}

	describe('create_objects handler', () => {
		it('POSTs to /api/graph with body', async () => {
			const mockResult = { nodes: [{ id: '1' }], edges: [] }
			mockFetchSuccess(mockResult)

			const handler = handlers.get('create_objects')!
			const result = await handler({
				nodes: [{ $id: 'bet-1', type: 'bet', status: 'active' }],
				edges: [],
			}) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/graph',
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						Authorization: 'Bearer ank_testkey123',
						'X-Workspace-Id': 'ws-default-123',
					}),
				}),
			)

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toEqual(mockResult)
		})

		it('uses workspace_id from args over default', async () => {
			mockFetchSuccess({})

			const handler = handlers.get('create_objects')!
			await handler({
				workspace_id: 'ws-custom',
				nodes: [{ $id: 'x', type: 'task', status: 'todo' }],
				edges: [],
			})

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/graph',
				expect.objectContaining({
					headers: expect.objectContaining({
						'X-Workspace-Id': 'ws-custom',
					}),
				}),
			)
		})
	})

	describe('get_objects handler', () => {
		it('GETs /api/objects/:id/graph for each ID', async () => {
			mockFetchSuccess({ id: '1', title: 'Test' })

			const handler = handlers.get('get_objects')!
			const result = await handler({ ids: ['id-1', 'id-2'] }) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledTimes(2)
			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/objects/id-1/graph',
				expect.anything(),
			)
			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/objects/id-2/graph',
				expect.anything(),
			)

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toHaveLength(2)
			expect(parsed[0].success).toBe(true)
		})
	})

	describe('list_objects handler', () => {
		it('GETs /api/objects with query params', async () => {
			mockFetchSuccess([])

			const handler = handlers.get('list_objects')!
			await handler({ type: 'task', limit: 10, offset: 5 })

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).toContain('/api/objects?')
			expect(calledUrl).toContain('type=task')
			expect(calledUrl).toContain('limit=10')
			expect(calledUrl).toContain('offset=5')
		})
	})

	describe('delete_object handler', () => {
		it('DELETEs /api/objects/:id', async () => {
			mockFetchSuccess({})

			const handler = handlers.get('delete_object')!
			await handler({ id: 'obj-123' })

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/objects/obj-123',
				expect.objectContaining({ method: 'DELETE' }),
			)
		})
	})

	describe('create_actor handler', () => {
		it('POSTs to /api/actors with skipAuth', async () => {
			mockFetchSuccess({ id: 'actor-new', name: 'Bot', type: 'agent' })

			const handler = handlers.get('create_actor')!
			await handler({ type: 'agent', name: 'Bot' })

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/actors',
				expect.objectContaining({ method: 'POST' }),
			)
		})

		it('adds to workspace when workspace_id provided', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'actor-new' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({}),
				} as Response)

			const handler = handlers.get('create_actor')!
			const result = await handler({
				type: 'agent', name: 'Bot', workspace_id: 'ws-123',
			}) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledTimes(2)
			expect(fetch).toHaveBeenLastCalledWith(
				'http://localhost:3000/api/workspaces/ws-123/members',
				expect.objectContaining({ method: 'POST' }),
			)

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.workspace_id).toBe('ws-123')
			expect(parsed.role).toBe('member')
		})
	})

	describe('create_session handler', () => {
		it('POSTs to /api/sessions', async () => {
			mockFetchSuccess({ id: 'session-1', status: 'pending' })

			const handler = handlers.get('create_session')!
			await handler({
				actor_id: 'actor-1',
				action_prompt: 'Fix bugs',
				auto_start: true,
			})

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/sessions',
				expect.objectContaining({ method: 'POST' }),
			)
		})
	})

	describe('error handling', () => {
		it('throws with API error message', async () => {
			mockFetchError(400, JSON.stringify({
				error: { message: 'Validation failed', details: [{ field: 'name', message: 'Required' }] },
			}))

			const handler = handlers.get('list_objects')!
			await expect(handler({})).rejects.toThrow('API error 400')
		})

		it('throws with suggestion when available', async () => {
			mockFetchError(401, JSON.stringify({
				error: { message: 'Unauthorized', suggestion: 'Check your API key' },
			}))

			const handler = handlers.get('list_objects')!
			await expect(handler({})).rejects.toThrow('Hint: Check your API key')
		})

		it('throws with raw text for non-JSON error', async () => {
			mockFetchError(500, 'Internal Server Error')

			const handler = handlers.get('list_objects')!
			await expect(handler({})).rejects.toThrow('Internal Server Error')
		})
	})

	describe('auth validation', () => {
		it('throws when no API key configured', async () => {
			const noKeyHandlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
			vi.mocked(registerAppTool).mockImplementation(
				(_server, name, _def, handler) => {
					noKeyHandlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
				},
			)
			createMcpServer({ ...config, apiKey: '' })

			const handler = noKeyHandlers.get('list_objects')!
			await expect(handler({})).rejects.toThrow('Not authenticated')
		})
	})
})
