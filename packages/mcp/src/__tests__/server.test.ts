import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the MCP SDK modules
vi.mock('@modelcontextprotocol/ext-apps/server', () => ({
	registerAppTool: vi.fn(),
	registerAppResource: vi.fn(),
	RESOURCE_MIME_TYPE: 'text/html',
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
	McpServer: class {
		registerPrompt = vi.fn()
	},
}))

vi.mock('node:fs', () => ({
	readFileSync: vi.fn().mockReturnValue('<html>mock</html>'),
}))

import { registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpServer } from '../server'
import { tools } from '../tools'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
}

describe('createMcpServer', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('registers a tool for every tool definition', () => {
		createMcpServer(config)
		expect(registerAppTool).toHaveBeenCalledTimes(Object.keys(tools).length)
	})

	it('registers a UI resource for every defined resource', () => {
		createMcpServer(config)
		// UI_RESOURCES has 7 entries: objects, relationships, actors, workspaces, events, triggers, graph
		const resourceCount = vi.mocked(registerAppResource).mock.calls.length
		expect(resourceCount).toBeGreaterThan(0)
		// Verify all expected URIs are present
		const resourceUris = vi.mocked(registerAppResource).mock.calls.map((call) => call[2])
		const expectedUris = [
			'ui://maskin/objects',
			'ui://maskin/actors',
			'ui://maskin/workspaces',
			'ui://maskin/events',
			'ui://maskin/triggers',
			'ui://maskin/relationships',
			'ui://maskin/graph',
		]
		for (const uri of expectedUris) {
			expect(resourceUris).toContain(uri)
		}
		expect(resourceCount).toBe(expectedUris.length)
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

	it('registers every tool name from tools definitions', () => {
		createMcpServer(config)
		const registeredNames = vi.mocked(registerAppTool).mock.calls.map((call) => call[1])
		for (const name of Object.keys(tools)) {
			expect(registeredNames).toContain(name)
		}
	})

	it('registers all expected MCP prompts', () => {
		const server = createMcpServer(config)
		const mockServer = server as unknown as { registerPrompt: ReturnType<typeof vi.fn> }
		const promptNames = mockServer.registerPrompt.mock.calls.map(
			(call: unknown[]) => call[0] as string,
		)
		expect(promptNames).toContain('workspace-overview')
		expect(promptNames).toContain('daily-standup')
		expect(promptNames).toContain('review-task-backlog')
		expect(promptNames).toContain('weekly-digest')
		expect(promptNames).toContain('relationship-map')
		expect(mockServer.registerPrompt).toHaveBeenCalledTimes(5)
	})

	it('registers prompts with title, description, and message callback', () => {
		const server = createMcpServer(config)
		const mockServer = server as unknown as { registerPrompt: ReturnType<typeof vi.fn> }

		for (const call of mockServer.registerPrompt.mock.calls) {
			const [_name, metadata, callback] = call as [
				string,
				{ title: string; description: string },
				() => { messages: Array<{ role: string; content: { type: string; text: string } }> },
			]
			// Each prompt has title and description
			expect(metadata.title).toBeTruthy()
			expect(metadata.description).toBeTruthy()
			// Callback returns messages array
			const result = callback()
			expect(result.messages).toHaveLength(1)
			expect(result.messages[0].role).toBe('user')
			expect(result.messages[0].content.type).toBe('text')
			expect(result.messages[0].content.text.length).toBeGreaterThan(0)
		}
	})
})

describe('tool handlers', () => {
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = new Map()

		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
		})

		createMcpServer(config)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	function getHandler(name: string) {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`Handler ${name} not registered`)
		return handler
	}

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

			const handler = getHandler('create_objects')
			const result = (await handler({
				nodes: [{ $id: 'bet-1', type: 'bet', status: 'active' }],
				edges: [],
			})) as { structuredContent: unknown; content: Array<{ text: string }> }

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

			expect(result.structuredContent).toEqual(mockResult)
			// JSON fallback in content[1]
			const parsed = JSON.parse(result.content[1].text)
			expect(parsed).toEqual(mockResult)
		})

		it('uses workspace_id from args over default', async () => {
			mockFetchSuccess({})

			const handler = getHandler('create_objects')
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

			const handler = getHandler('get_objects')
			const result = (await handler({ ids: ['id-1', 'id-2'] })) as {
				structuredContent: Array<{ success: boolean }>
				content: Array<{ text: string }>
			}

			expect(fetch).toHaveBeenCalledTimes(2)
			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/objects/id-1/graph',
				expect.anything(),
			)
			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/objects/id-2/graph',
				expect.anything(),
			)

			expect(result.structuredContent.data).toHaveLength(2)
			expect(result.structuredContent.data[0].success).toBe(true)
			// JSON fallback in content[1]
			const parsed = JSON.parse(result.content[1].text)
			expect(parsed.data).toHaveLength(2)
			expect(parsed.data[0].success).toBe(true)
		})
	})

	describe('list_objects handler', () => {
		it('GETs /api/objects with query params', async () => {
			mockFetchSuccess([])

			const handler = getHandler('list_objects')
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

			const handler = getHandler('delete_object')
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

			const handler = getHandler('create_actor')
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

			const handler = getHandler('create_actor')
			const result = (await handler({
				type: 'agent',
				name: 'Bot',
				workspace_id: 'ws-123',
			})) as { structuredContent: Record<string, unknown>; content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledTimes(2)
			expect(fetch).toHaveBeenLastCalledWith(
				'http://localhost:3000/api/workspaces/ws-123/members',
				expect.objectContaining({ method: 'POST' }),
			)

			expect(result.structuredContent.workspace_id).toBe('ws-123')
			expect(result.structuredContent.role).toBe('member')
			// JSON fallback in content[1]
			const parsed = JSON.parse(result.content[1].text)
			expect(parsed.workspace_id).toBe('ws-123')
			expect(parsed.role).toBe('member')
		})
	})

	describe('get_objects handler (partial failure)', () => {
		it('returns success false for failed IDs without rejecting', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'id-1', title: 'OK' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: false,
					status: 404,
					text: () => Promise.resolve('Not found'),
				} as Response)

			const handler = getHandler('get_objects')
			const result = (await handler({ ids: ['id-1', 'id-2'] })) as {
				structuredContent: {
					data: Array<{
						success: boolean
						result?: Record<string, unknown>
						error?: string
					}>
				}
				content: Array<{ text: string }>
			}

			expect(result.structuredContent.data).toHaveLength(2)
			expect(result.structuredContent.data[0].success).toBe(true)
			expect(result.structuredContent.data[0].result).toEqual({ id: 'id-1', title: 'OK' })
			expect(result.structuredContent.data[1].success).toBe(false)
			expect(result.structuredContent.data[1].error).toContain('API error 404')
			// JSON fallback in content[1]
			const parsed = JSON.parse(result.content[1].text)
			expect(parsed.data).toHaveLength(2)
			expect(parsed.data[0].success).toBe(true)
			expect(parsed.data[1].success).toBe(false)
		})
	})

	describe('create_session handler', () => {
		it('POSTs to /api/sessions', async () => {
			mockFetchSuccess({ id: 'session-1', status: 'pending' })

			const handler = getHandler('create_session')
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

	describe('run_agent handler', () => {
		it('creates session, polls until completed, fetches logs', async () => {
			vi.useFakeTimers()
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				// 1. POST /api/sessions — create session
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'sess-1', status: 'pending' }),
				} as Response)
				// 2. GET /api/sessions/sess-1 — first poll (running)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'sess-1', status: 'running' }),
				} as Response)
				// 3. GET /api/sessions/sess-1 — second poll (completed)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'sess-1', status: 'completed' }),
				} as Response)
				// 4. GET /api/sessions/sess-1/logs — fetch logs
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([{ message: 'Done' }]),
				} as Response)

			const handler = getHandler('run_agent')
			const resultPromise = handler({
				actor_id: 'actor-1',
				action_prompt: 'Fix bugs',
				poll_interval_seconds: 5,
				timeout_seconds: 60,
			})

			// Advance through the two polling intervals
			await vi.advanceTimersByTimeAsync(5000) // first poll → running
			await vi.advanceTimersByTimeAsync(5000) // second poll → completed

			const result = (await resultPromise) as {
				structuredContent: { session: { status: string }; logs: unknown[] }
				content: Array<{ text: string }>
			}

			expect(result.structuredContent.session.status).toBe('completed')
			expect(result.structuredContent.logs).toEqual([{ message: 'Done' }])
			// JSON fallback in content[1]
			const parsed = JSON.parse(result.content[1].text)
			expect(parsed.session.status).toBe('completed')
			expect(parsed.logs).toEqual([{ message: 'Done' }])

			// Verify call sequence: create → poll → poll → logs
			expect(fetchSpy).toHaveBeenCalledTimes(4)
			expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:3000/api/sessions')
			expect(fetchSpy.mock.calls[1][0]).toBe('http://localhost:3000/api/sessions/sess-1')
			expect(fetchSpy.mock.calls[2][0]).toBe('http://localhost:3000/api/sessions/sess-1')
			expect(fetchSpy.mock.calls[3][0]).toBe(
				'http://localhost:3000/api/sessions/sess-1/logs?limit=500',
			)
		})

		it('stops polling when deadline is reached', async () => {
			vi.useFakeTimers()
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				// 1. POST /api/sessions — create session
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'sess-2', status: 'pending' }),
				} as Response)
				// All subsequent polls return 'running' (never terminal)
				.mockResolvedValue({
					ok: true,
					json: () => Promise.resolve({ id: 'sess-2', status: 'running' }),
				} as Response)

			const handler = getHandler('run_agent')
			// Very short timeout (10s) with 5s poll interval = at most 2 polls before deadline
			const resultPromise = handler({
				actor_id: 'actor-1',
				action_prompt: 'Long task',
				poll_interval_seconds: 5,
				timeout_seconds: 10,
			})

			// Advance past deadline
			await vi.advanceTimersByTimeAsync(5000) // first poll
			await vi.advanceTimersByTimeAsync(5000) // second poll
			await vi.advanceTimersByTimeAsync(5000) // past deadline

			const result = (await resultPromise) as {
				structuredContent: { session: { status: string }; logs: unknown }
				content: Array<{ text: string }>
			}

			// Session should still show 'running' since it never reached terminal
			expect(result.structuredContent.session.status).toBe('running')
			// Should have fetched logs even though it timed out
			expect(result.structuredContent.logs).toBeDefined()
			// JSON fallback in content[1]
			const parsed = JSON.parse(result.content[1].text)
			expect(parsed.session.status).toBe('running')
		})

		it('uses default poll_interval and timeout when not specified', async () => {
			vi.useFakeTimers()
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'sess-3', status: 'pending' }),
				} as Response)
				// Immediate completion on first poll
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'sess-3', status: 'completed' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([]),
				} as Response)

			const handler = getHandler('run_agent')
			const resultPromise = handler({
				actor_id: 'actor-1',
				action_prompt: 'Quick task',
			})

			// Default poll interval is 5s
			await vi.advanceTimersByTimeAsync(5000)

			const result = (await resultPromise) as {
				structuredContent: { session: { status: string } }
				content: Array<{ text: string }>
			}
			expect(result.structuredContent.session.status).toBe('completed')
			// JSON fallback in content[1]
			const parsed = JSON.parse(result.content[1].text)
			expect(parsed.session.status).toBe('completed')
		})
	})

	describe('hello handler', () => {
		it('returns welcome with workspace and members', async () => {
			const workspace = {
				id: 'ws-1',
				name: 'My Workspace',
				settings: {
					statuses: { insight: ['new', 'processing'], bet: ['active'] },
					field_definitions: {},
					display_names: {},
					relationship_types: ['informs', 'blocks'],
					max_concurrent_sessions: 3,
				},
			}
			const members = [
				{ actorId: 'a-1', name: 'Alice', type: 'human', role: 'owner' },
				{ actorId: 'a-2', name: 'Bot', type: 'agent', role: 'member' },
			]

			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([workspace]),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve(members),
				} as Response)

			const handler = getHandler('hello')
			const result = (await handler({})) as { content: Array<{ text: string }> }
			const text = result.content[0].text

			expect(text).toContain('Welcome to Maskin')
			expect(text).toContain('My Workspace')
			expect(text).toContain('ws-1')
			expect(text).toContain('Alice')
			expect(text).toContain('Bot')
			expect(text).toContain('informs, blocks')
		})

		it('shows fallback when no workspaces exist', async () => {
			mockFetchSuccess([])

			const handler = getHandler('hello')
			const result = (await handler({})) as { content: Array<{ text: string }> }
			const text = result.content[0].text

			expect(text).toContain('No workspace found')
			expect(text).toContain('create_workspace')
		})

		it('degrades gracefully when API call fails', async () => {
			vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))

			const handler = getHandler('hello')
			const result = (await handler({})) as { content: Array<{ text: string }> }
			const text = result.content[0].text

			expect(text).toContain('Welcome to Maskin')
			expect(text).toContain('Not connected yet')
			expect(text).toContain('create_actor')
		})

		it('selects workspace matching workspace_id arg', async () => {
			const ws1 = { id: 'ws-1', name: 'First', settings: {} }
			const ws2 = { id: 'ws-2', name: 'Second', settings: {} }

			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([ws1, ws2]),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([]),
				} as Response)

			const handler = getHandler('hello')
			const result = (await handler({ workspace_id: 'ws-2' })) as {
				content: Array<{ text: string }>
			}
			const text = result.content[0].text

			expect(text).toContain('Second')
			expect(text).toContain('ws-2')
		})

		it('includes all tool names dynamically', async () => {
			mockFetchSuccess([])

			const handler = getHandler('hello')
			const result = (await handler({})) as { content: Array<{ text: string }> }
			const text = result.content[0].text

			for (const toolName of Object.keys(tools)) {
				if (toolName === 'hello') continue
				expect(text).toContain(toolName)
			}
		})

		it('shows custom object types from workspace settings', async () => {
			const workspace = {
				id: 'ws-1',
				name: 'Custom',
				settings: {
					statuses: { meeting: ['scheduled', 'done'], insight: ['new'] },
					field_definitions: {},
					display_names: { meeting: 'Meeting' },
				},
			}

			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([workspace]),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([]),
				} as Response)

			const handler = getHandler('hello')
			const result = (await handler({})) as { content: Array<{ text: string }> }
			const text = result.content[0].text

			expect(text).toContain('Meeting')
			expect(text).toContain('meeting')
			expect(text).toContain('scheduled')
		})
	})

	describe('error handling', () => {
		it('throws with API error message', async () => {
			mockFetchError(
				400,
				JSON.stringify({
					error: {
						message: 'Validation failed',
						details: [{ field: 'name', message: 'Required' }],
					},
				}),
			)

			const handler = getHandler('list_objects')
			await expect(handler({})).rejects.toThrow('API error 400')
		})

		it('throws with suggestion when available', async () => {
			mockFetchError(
				401,
				JSON.stringify({
					error: { message: 'Unauthorized', suggestion: 'Check your API key' },
				}),
			)

			const handler = getHandler('list_objects')
			await expect(handler({})).rejects.toThrow('Hint: Check your API key')
		})

		it('throws with raw text for non-JSON error', async () => {
			mockFetchError(500, 'Internal Server Error')

			const handler = getHandler('list_objects')
			await expect(handler({})).rejects.toThrow('Internal Server Error')
		})
	})

	describe('auth validation', () => {
		it('throws when no API key configured', async () => {
			const noKeyHandlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
			vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
				noKeyHandlers.set(
					name as string,
					handler as (args: Record<string, unknown>) => Promise<unknown>,
				)
			})
			createMcpServer({ ...config, apiKey: '' })

			const handler = noKeyHandlers.get('list_objects')
			if (!handler) throw new Error('Handler list_objects not registered')
			await expect(handler({})).rejects.toThrow('Not authenticated')
		})
	})

	describe('workspace_dashboard handler', () => {
		it('fetches workspace, objects, events, sessions, and members in parallel', async () => {
			const workspace = { id: 'ws-default-123', name: 'Test WS' }
			const objects = [
				{ id: 'obj-1', type: 'task', status: 'todo', title: 'Task 1' },
				{ id: 'obj-2', type: 'bet', status: 'active', title: 'Bet 1' },
			]
			const events = [{ id: 'evt-1', action: 'created', entityType: 'task' }]
			const sessions = [{ id: 'sess-1', status: 'running', actorName: 'Bot' }]
			const members = [{ actorId: 'a-1', name: 'Alice', type: 'human', role: 'owner' }]

			vi.spyOn(globalThis, 'fetch')
				// 1. GET /api/workspaces
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([workspace]),
				} as Response)
				// 2. GET /api/objects?limit=50
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve(objects),
				} as Response)
				// 3. GET /api/events/history?limit=20
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve(events),
				} as Response)
				// 4. GET /api/sessions?status=running
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve(sessions),
				} as Response)
				// 5. GET /api/workspaces/.../members
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve(members),
				} as Response)

			const handler = getHandler('workspace_dashboard')
			const result = (await handler({})) as {
				structuredContent: {
					workspace: Record<string, unknown>
					objects: unknown[]
					events: unknown[]
					sessions: unknown[]
					members: unknown[]
				}
				content: Array<{ text: string }>
			}

			// 5 parallel fetches
			expect(fetch).toHaveBeenCalledTimes(5)

			// structuredContent contains all data
			expect(result.structuredContent.workspace).toEqual(workspace)
			expect(result.structuredContent.objects).toHaveLength(2)
			expect(result.structuredContent.events).toHaveLength(1)
			expect(result.structuredContent.sessions).toHaveLength(1)
			expect(result.structuredContent.members).toHaveLength(1)

			// Formatted text contains dashboard heading
			expect(result.content[0].text).toContain('Workspace Dashboard')
			expect(result.content[0].text).toContain('Test WS')

			// JSON fallback in content[1]
			const parsed = JSON.parse(result.content[1].text)
			expect(parsed.workspace.name).toBe('Test WS')
			expect(parsed.objects).toHaveLength(2)
		})

		it('gracefully handles API failures with empty arrays', async () => {
			// All API calls fail
			vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))

			const handler = getHandler('workspace_dashboard')
			const result = (await handler({})) as {
				structuredContent: {
					workspace: Record<string, unknown>
					objects: unknown[]
					events: unknown[]
					sessions: unknown[]
					members: unknown[]
				}
				content: Array<{ text: string }>
			}

			// Failures are caught — returns empty data
			expect(result.structuredContent.objects).toEqual([])
			expect(result.structuredContent.events).toEqual([])
			expect(result.structuredContent.sessions).toEqual([])
			expect(result.structuredContent.members).toEqual([])
		})
	})

	describe('create_notification handler', () => {
		it('passes native array metadata.actions through unchanged', async () => {
			const mockResult = { id: 'notif-1' }
			mockFetchSuccess(mockResult)

			const handler = getHandler('create_notification')
			const actions = [{ label: 'Approve', response: 'approved' }]
			await handler({
				type: 'needs_input',
				title: 'Test',
				source_actor_id: '00000000-0000-0000-0000-000000000001',
				metadata: { actions },
			})

			const fetchCall = vi.mocked(fetch).mock.calls[0]
			const body = JSON.parse(fetchCall[1]?.body as string)
			expect(body.metadata.actions).toEqual(actions)
		})

		it('auto-parses JSON string metadata.actions into an array', async () => {
			const mockResult = { id: 'notif-1' }
			mockFetchSuccess(mockResult)

			const handler = getHandler('create_notification')
			const actions = [{ label: 'Approve', response: 'approved' }]
			await handler({
				type: 'needs_input',
				title: 'Test',
				source_actor_id: '00000000-0000-0000-0000-000000000001',
				metadata: { actions: JSON.stringify(actions) },
			})

			const fetchCall = vi.mocked(fetch).mock.calls[0]
			const body = JSON.parse(fetchCall[1]?.body as string)
			expect(body.metadata.actions).toEqual(actions)
		})

		it('throws when metadata.actions is an invalid JSON string', async () => {
			const handler = getHandler('create_notification')
			await expect(
				handler({
					type: 'needs_input',
					title: 'Test',
					source_actor_id: '00000000-0000-0000-0000-000000000001',
					metadata: { actions: 'not valid json' },
				}),
			).rejects.toThrow('metadata.actions must be a valid JSON array or native array')
		})

		it('throws when metadata.actions is a JSON string of a non-array', async () => {
			const handler = getHandler('create_notification')
			await expect(
				handler({
					type: 'needs_input',
					title: 'Test',
					source_actor_id: '00000000-0000-0000-0000-000000000001',
					metadata: { actions: '{"label": "test"}' },
				}),
			).rejects.toThrow('metadata.actions must be an array')
		})

		it('throws when metadata.actions is a non-array non-string', async () => {
			const handler = getHandler('create_notification')
			await expect(
				handler({
					type: 'needs_input',
					title: 'Test',
					source_actor_id: '00000000-0000-0000-0000-000000000001',
					metadata: { actions: 42 },
				}),
			).rejects.toThrow('metadata.actions must be an array')
		})

		it('works when metadata has no actions field', async () => {
			const mockResult = { id: 'notif-1' }
			mockFetchSuccess(mockResult)

			const handler = getHandler('create_notification')
			await handler({
				type: 'needs_input',
				title: 'Test',
				source_actor_id: '00000000-0000-0000-0000-000000000001',
				metadata: { urgency_label: 'high' },
			})

			expect(fetch).toHaveBeenCalledTimes(1)
		})
	})
})
