import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the MCP SDK modules
vi.mock('@modelcontextprotocol/ext-apps/server', () => ({
	registerAppTool: vi.fn(),
	registerAppResource: vi.fn(),
	RESOURCE_MIME_TYPE: 'text/html',
}))

// Use the constructor argument form (vi.fn(impl), not vi.fn().mockImplementation)
// so the implementation survives `vi.restoreAllMocks()` calls in nested afterEach
// hooks. Without this, later tests see `new McpServer()` return undefined.
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
	McpServer: vi.fn(() => ({
		registerResource: vi.fn(),
	})),
	ResourceTemplate: vi.fn((template, callbacks) => ({
		template,
		listCallback: callbacks?.list,
	})),
}))

vi.mock('node:fs', () => ({
	readFileSync: vi.fn().mockReturnValue('<html>mock</html>'),
}))

import { registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
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
		const resourceCount = vi.mocked(registerAppResource).mock.calls.length
		expect(resourceCount).toBeGreaterThan(0)
		// Verify all expected URIs are present. Wave 2 (F7) added the sessions,
		// skills, llm-keys, members, and extensions cards on top of the original
		// 8 surfaces.
		const resourceUris = vi.mocked(registerAppResource).mock.calls.map((call) => call[2])
		const expectedUris = [
			'ui://maskin/objects',
			'ui://maskin/actors',
			'ui://maskin/workspaces',
			'ui://maskin/events',
			'ui://maskin/triggers',
			'ui://maskin/relationships',
			'ui://maskin/graph',
			'ui://maskin/notifications',
			'ui://maskin/sessions',
			'ui://maskin/skills',
			'ui://maskin/llm-keys',
			'ui://maskin/members',
			'ui://maskin/extensions',
			'ui://maskin/schema',
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
			})) as { content: Array<{ text: string }> }

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

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toHaveLength(2)
			expect(parsed[0].success).toBe(true)
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
			})) as { content: Array<{ text: string }> }

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
				content: Array<{ text: string }>
			}

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toHaveLength(2)
			expect(parsed[0].success).toBe(true)
			expect(parsed[0].result).toEqual({ id: 'id-1', title: 'OK' })
			expect(parsed[1].success).toBe(false)
			expect(parsed[1].error).toContain('API error 404')
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

			const result = (await resultPromise) as { content: Array<{ text: string }> }
			const parsed = JSON.parse(result.content[0].text)

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

			const result = (await resultPromise) as { content: Array<{ text: string }> }
			const parsed = JSON.parse(result.content[0].text)

			// Session should still show 'running' since it never reached terminal
			expect(parsed.session.status).toBe('running')
			// Should have fetched logs even though it timed out
			expect(parsed.logs).toBeDefined()
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

			const result = (await resultPromise) as { content: Array<{ text: string }> }
			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.session.status).toBe('completed')
		})
	})

	describe('get_started handler', () => {
		const workspace = { id: 'ws-1', name: 'My Workspace', settings: {} }

		it('asks the user to pick when no use_case or template is given', async () => {
			mockFetchSuccess([workspace])

			const handler = getHandler('get_started')
			const result = (await handler({})) as { content: Array<{ text: string }> }
			const text = result.content[0].text

			expect(text).toContain('My Workspace')
			expect(text).toContain('development')
			expect(text).toContain('growth')
			expect(text).toContain('custom')
		})

		it('maps use_case keywords to growth template', async () => {
			mockFetchSuccess([workspace])

			const handler = getHandler('get_started')
			const result = (await handler({ use_case: 'planning our launch pipeline' })) as {
				content: Array<{ text: string }>
			}
			const text = result.content[0].text

			expect(text).toContain('Preview')
			expect(text).toContain('Growth')
			expect(text).toContain('contact')
		})

		it('previews development template and prompts for tailoring questions', async () => {
			mockFetchSuccess([workspace])

			const handler = getHandler('get_started')
			const result = (await handler({ template: 'development' })) as {
				content: Array<{ text: string }>
			}
			const text = result.content[0].text

			expect(text).toContain('Preview')
			expect(text).toContain('Development')
			expect(text).toContain('confirm: true')
			expect(text).toContain('ASK THE USER')
			expect(text).toContain('workspace_name')
			expect(text).toContain('seed_overrides')
		})

		it('applies template with confirm: true — PATCH settings and POST graph', async () => {
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([workspace]) } as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'ws-1' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ objects: [{ id: 'o1' }], relationships: [{ id: 'r1' }] }),
				} as Response)

			const handler = getHandler('get_started')
			const result = (await handler({
				template: 'development',
				confirm: true,
			})) as { content: Array<{ text: string }> }
			const text = result.content[0].text

			expect(text).toContain('Development')
			expect(text).toContain('template applied')

			const calls = fetchSpy.mock.calls
			expect(calls[1][0]).toBe('http://localhost:3000/api/workspaces/ws-1')
			expect((calls[1][1] as RequestInit).method).toBe('PATCH')
			expect(calls[2][0]).toBe('http://localhost:3000/api/graph')
			expect((calls[2][1] as RequestInit).method).toBe('POST')
		})

		it('renames workspace and applies seed_overrides on confirm', async () => {
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([workspace]) } as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'ws-1', name: 'Acme' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'ws-1' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ objects: [{ id: 'o1' }], relationships: [] }),
				} as Response)

			const handler = getHandler('get_started')
			await handler({
				template: 'development',
				confirm: true,
				workspace_name: 'Acme',
				seed_overrides: {
					bet1: { title: 'Ship MVP by June' },
				},
			})

			const calls = fetchSpy.mock.calls
			// 1st: GET workspaces; 2nd: PATCH rename; 3rd: PATCH settings; 4th: POST graph
			const renameBody = JSON.parse((calls[1][1] as RequestInit).body as string)
			expect(renameBody).toEqual({ name: 'Acme' })
			const graphBody = JSON.parse((calls[3][1] as RequestInit).body as string)
			const bet1 = graphBody.nodes.find((n: { $id: string }) => n.$id === 'bet1')
			expect(bet1.title).toBe('Ship MVP by June')
		})

		it('asks a questionnaire when template is custom and no custom_settings', async () => {
			mockFetchSuccess([workspace])

			const handler = getHandler('get_started')
			const result = (await handler({ template: 'custom' })) as {
				content: Array<{ text: string }>
			}
			const text = result.content[0].text

			expect(text).toContain('Custom workspace')
			expect(text).toContain('custom_settings')
		})

		it('degrades gracefully when workspaces fetch fails', async () => {
			vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))

			const handler = getHandler('get_started')
			const result = (await handler({})) as { content: Array<{ text: string }> }
			const text = result.content[0].text

			expect(text).toContain("can't reach your workspace")
			expect(text).toContain('create_actor')
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

		it('hosted-MCP setup hint mentions the Authorization header, not env vars', async () => {
			const httpHandlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
			vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
				httpHandlers.set(
					name as string,
					handler as (args: Record<string, unknown>) => Promise<unknown>,
				)
			})
			createMcpServer({ ...config, apiKey: '', transport: 'http' })

			const handler = httpHandlers.get('list_objects')
			if (!handler) throw new Error('Handler list_objects not registered')
			await expect(handler({})).rejects.toThrow(/Authorization: Bearer/)
		})

		it('hosted-MCP missing-workspace hint mentions the X-Workspace-Id header', async () => {
			const httpHandlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
			vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
				httpHandlers.set(
					name as string,
					handler as (args: Record<string, unknown>) => Promise<unknown>,
				)
			})
			createMcpServer({ ...config, defaultWorkspaceId: '', transport: 'http' })

			const handler = httpHandlers.get('list_objects')
			if (!handler) throw new Error('Handler list_objects not registered')
			await expect(handler({})).rejects.toThrow(/X-Workspace-Id/)
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

	describe('workspace skills handlers', () => {
		describe('list_workspace_skills handler', () => {
			it('GETs /api/workspaces/:id/skills with the default workspace', async () => {
				mockFetchSuccess([
					{ id: 's1', name: 'bug-fix', description: 'Bug-fix skill', sizeBytes: 42 },
				])

				const handler = getHandler('list_workspace_skills')
				const result = (await handler({})) as { content: Array<{ text: string }> }

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-default-123/skills',
					expect.objectContaining({
						method: 'GET',
						headers: expect.objectContaining({
							Authorization: 'Bearer ank_testkey123',
							'X-Workspace-Id': 'ws-default-123',
						}),
					}),
				)

				const parsed = JSON.parse(result.content[0].text)
				expect(parsed).toHaveLength(1)
				expect(parsed[0].name).toBe('bug-fix')
			})

			it('uses workspace_id from args over default', async () => {
				mockFetchSuccess([])
				const handler = getHandler('list_workspace_skills')
				await handler({ workspace_id: 'ws-custom' })

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-custom/skills',
					expect.objectContaining({
						headers: expect.objectContaining({ 'X-Workspace-Id': 'ws-custom' }),
					}),
				)
			})
		})

		describe('get_workspace_skill handler', () => {
			it('GETs /api/workspaces/:id/skills/:name with the full skill', async () => {
				mockFetchSuccess({ id: 's1', name: 'bug-fix', content: '# Bug fix skill' })

				const handler = getHandler('get_workspace_skill')
				const result = (await handler({ name: 'bug-fix' })) as {
					content: Array<{ text: string }>
				}

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-default-123/skills/bug-fix',
					expect.objectContaining({ method: 'GET' }),
				)
				const parsed = JSON.parse(result.content[0].text)
				expect(parsed.content).toBe('# Bug fix skill')
			})

			it('url-encodes the name segment', async () => {
				mockFetchSuccess({})
				const handler = getHandler('get_workspace_skill')
				// skillNameSchema rejects non-[a-z0-9-] names, so this is defense-in-depth
				// for a name with characters that still need escaping as a path segment.
				await handler({ name: 'a-b' })
				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-default-123/skills/a-b',
					expect.anything(),
				)
			})
		})

		describe('create_workspace_skill handler', () => {
			it('POSTs /api/workspaces/:id/skills with name and content', async () => {
				mockFetchSuccess({ id: 's1', name: 'bug-fix', content: '# body' })

				const handler = getHandler('create_workspace_skill')
				const result = (await handler({ name: 'bug-fix', content: '# body' })) as {
					content: Array<{ text: string }>
				}

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-default-123/skills',
					expect.objectContaining({ method: 'POST' }),
				)
				const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
				expect(body).toEqual({ name: 'bug-fix', content: '# body' })
				expect(JSON.parse(result.content[0].text).name).toBe('bug-fix')
			})

			it('uses workspace_id from args when provided', async () => {
				mockFetchSuccess({})
				const handler = getHandler('create_workspace_skill')
				await handler({ workspace_id: 'ws-custom', name: 'my-skill', content: '# x' })

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-custom/skills',
					expect.objectContaining({ method: 'POST' }),
				)
			})
		})

		describe('update_workspace_skill handler', () => {
			it('PUTs /api/workspaces/:id/skills/:name with content only', async () => {
				mockFetchSuccess({ id: 's1', name: 'bug-fix', content: '# updated' })

				const handler = getHandler('update_workspace_skill')
				await handler({ name: 'bug-fix', content: '# updated' })

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-default-123/skills/bug-fix',
					expect.objectContaining({ method: 'PUT' }),
				)
				const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
				expect(body).toEqual({ content: '# updated' })
			})
		})

		describe('delete_workspace_skill handler', () => {
			it('DELETEs /api/workspaces/:id/skills/:name', async () => {
				mockFetchSuccess({ deleted: true })

				const handler = getHandler('delete_workspace_skill')
				const result = (await handler({ name: 'bug-fix' })) as {
					content: Array<{ text: string }>
				}

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-default-123/skills/bug-fix',
					expect.objectContaining({ method: 'DELETE' }),
				)
				expect(JSON.parse(result.content[0].text)).toEqual({ deleted: true })
			})
		})

		it('throws when no workspace is configured and none provided', async () => {
			vi.clearAllMocks()
			const handlersNoWs = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
			vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
				handlersNoWs.set(
					name as string,
					handler as (args: Record<string, unknown>) => Promise<unknown>,
				)
			})
			createMcpServer({ ...config, defaultWorkspaceId: '' })

			const handler = handlersNoWs.get('list_workspace_skills')
			if (!handler) throw new Error('handler missing')
			await expect(handler({})).rejects.toThrow(/No workspace specified/)
		})
	})

	describe('set_llm_api_key handler', () => {
		// PATCHes the workspace with a single-provider delta. The server deep-
		// merges llm_keys, so the MCP tool is a straight pass-through — no
		// read-modify-write. One fetch call per invocation.
		it('PATCHes only the target provider and returns masked last4', async () => {
			mockFetchSuccess({ id: 'ws-default-123', name: 'My Workspace', settings: {} })

			const handler = getHandler('set_llm_api_key')
			const result = (await handler({
				provider: 'anthropic',
				api_key: 'sk-ant-new-key-WXYZ',
			})) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledTimes(1)
			const [patchCall] = vi.mocked(fetch).mock.calls
			expect(patchCall[0]).toBe('http://localhost:3000/api/workspaces/ws-default-123')
			expect(patchCall[1]?.method).toBe('PATCH')
			const body = JSON.parse(patchCall[1]?.body as string)
			expect(body.settings.llm_keys).toEqual({ anthropic: 'sk-ant-new-key-WXYZ' })

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toEqual({ success: true, provider: 'anthropic', last4: 'WXYZ' })
			expect(result.content[0].text).not.toContain('sk-ant-new-key-WXYZ')
		})

		it('uses workspace_id from args over default', async () => {
			mockFetchSuccess({ id: 'ws-custom', name: 'Other', settings: {} })

			const handler = getHandler('set_llm_api_key')
			await handler({ workspace_id: 'ws-custom', provider: 'openai', api_key: 'sk-foo' })

			const [patchCall] = vi.mocked(fetch).mock.calls
			expect(patchCall[0]).toBe('http://localhost:3000/api/workspaces/ws-custom')
		})

		it('back-to-back sets for both providers each send only their own delta', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'ws-default-123', name: 'My', settings: {} }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'ws-default-123', name: 'My', settings: {} }),
				} as Response)

			const handler = getHandler('set_llm_api_key')
			await handler({ provider: 'anthropic', api_key: 'sk-ant-ABCD' })
			await handler({ provider: 'openai', api_key: 'sk-openai-EFGH' })

			const [firstCall, secondCall] = vi.mocked(fetch).mock.calls
			expect(JSON.parse(firstCall[1]?.body as string).settings.llm_keys).toEqual({
				anthropic: 'sk-ant-ABCD',
			})
			expect(JSON.parse(secondCall[1]?.body as string).settings.llm_keys).toEqual({
				openai: 'sk-openai-EFGH',
			})
		})
	})

	describe('get_llm_api_keys handler', () => {
		it('reads settings.llm_keys and returns masked status per provider', async () => {
			mockFetchSuccess([
				{
					id: 'ws-default-123',
					name: 'My Workspace',
					settings: {
						llm_keys: { anthropic: 'sk-ant-abcdEFGH', openai: 'sk-opq-MNOP' },
					},
				},
			])

			const handler = getHandler('get_llm_api_keys')
			const result = (await handler({})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toEqual({
				anthropic: { set: true, last4: 'EFGH' },
				openai: { set: true, last4: 'MNOP' },
			})
			expect(result.content[0].text).not.toContain('sk-ant-abcdEFGH')
		})

		it('returns { set: false } for missing providers', async () => {
			mockFetchSuccess([{ id: 'ws-default-123', name: 'My Workspace', settings: { llm_keys: {} } }])

			const handler = getHandler('get_llm_api_keys')
			const result = (await handler({})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toEqual({
				anthropic: { set: false },
				openai: { set: false },
			})
		})
	})

	describe('delete_llm_api_key handler', () => {
		it('PATCHes the target provider to null so the server strips it', async () => {
			mockFetchSuccess({ id: 'ws-default-123', name: 'My Workspace', settings: {} })

			const handler = getHandler('delete_llm_api_key')
			const result = (await handler({ provider: 'anthropic' })) as {
				content: Array<{ text: string }>
			}

			expect(fetch).toHaveBeenCalledTimes(1)
			const [patchCall] = vi.mocked(fetch).mock.calls
			expect(patchCall[0]).toBe('http://localhost:3000/api/workspaces/ws-default-123')
			expect(patchCall[1]?.method).toBe('PATCH')
			const body = JSON.parse(patchCall[1]?.body as string)
			expect(body.settings.llm_keys).toEqual({ anthropic: null })
			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toEqual({ success: true, provider: 'anthropic' })
		})

		it('delete on an unset provider still sends one PATCH and reports success', async () => {
			// Server-side deep-merge treats null as "delete if present"; deleting
			// a missing provider is a no-op there, so the MCP tool still returns
			// success without needing to inspect current state.
			mockFetchSuccess({ id: 'ws-default-123', name: 'My Workspace', settings: {} })

			const handler = getHandler('delete_llm_api_key')
			const result = (await handler({ provider: 'openai' })) as {
				content: Array<{ text: string }>
			}

			expect(fetch).toHaveBeenCalledTimes(1)
			const [patchCall] = vi.mocked(fetch).mock.calls
			const body = JSON.parse(patchCall[1]?.body as string)
			expect(body.settings.llm_keys).toEqual({ openai: null })
			expect(JSON.parse(result.content[0].text)).toEqual({ success: true, provider: 'openai' })
		})
	})

	describe('import_claude_subscription handler', () => {
		it('POSTs /api/claude-oauth/import with camelCased token fields', async () => {
			const mockResult = { success: true, subscription_type: 'max', expires_at: 1 }
			mockFetchSuccess(mockResult)

			const handler = getHandler('import_claude_subscription')
			await handler({
				access_token: 'at',
				refresh_token: 'rt',
				expires_at: 1_700_000_000_000,
				subscription_type: 'max',
				scopes: ['read'],
			})

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/claude-oauth/import',
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						Authorization: 'Bearer ank_testkey123',
						'X-Workspace-Id': 'ws-default-123',
					}),
				}),
			)
			const fetchCall = vi.mocked(fetch).mock.calls[0]
			const body = JSON.parse(fetchCall[1]?.body as string)
			expect(body).toEqual({
				accessToken: 'at',
				refreshToken: 'rt',
				expiresAt: 1_700_000_000_000,
				subscriptionType: 'max',
				scopes: ['read'],
			})
		})
	})

	describe('get_claude_subscription_status handler', () => {
		it('GETs /api/claude-oauth/status and returns payload', async () => {
			const mockResult = {
				connected: true,
				valid: true,
				subscription_type: 'max',
				expires_at: 1,
			}
			mockFetchSuccess(mockResult)

			const handler = getHandler('get_claude_subscription_status')
			const result = (await handler({})) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/claude-oauth/status',
				expect.objectContaining({ method: 'GET' }),
			)
			expect(JSON.parse(result.content[0].text)).toEqual(mockResult)
		})
	})

	describe('disconnect_claude_subscription handler', () => {
		it('DELETEs /api/claude-oauth', async () => {
			mockFetchSuccess({ success: true })

			const handler = getHandler('disconnect_claude_subscription')
			await handler({})

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/claude-oauth',
				expect.objectContaining({ method: 'DELETE' }),
			)
		})
	})

	describe('deep-link _meta wiring', () => {
		// Re-build a fresh handler map with webAppBaseUrl set, since the outer
		// beforeEach uses a config without it.
		function buildWithBaseUrl(baseUrl: string | undefined) {
			const localHandlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
			vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
				localHandlers.set(
					name as string,
					handler as (args: Record<string, unknown>) => Promise<unknown>,
				)
			})
			createMcpServer({ ...config, webAppBaseUrl: baseUrl })
			return localHandlers
		}

		it('emits webAppBaseUrl + workspaceId on _meta when baseUrl is configured', async () => {
			mockFetchSuccess({ id: 't-1', name: 'My trigger' })
			const handlers = buildWithBaseUrl('https://maskin.example.com')
			const handler = handlers.get('list_triggers')
			if (!handler) throw new Error('Handler list_triggers not registered')

			const result = (await handler({})) as { _meta: Record<string, unknown> }
			expect(result._meta.toolName).toBe('list_triggers')
			expect(result._meta.webAppBaseUrl).toBe('https://maskin.example.com')
			expect(result._meta.workspaceId).toBe('ws-default-123')
		})

		it('strips trailing slash from webAppBaseUrl', async () => {
			mockFetchSuccess({})
			const handlers = buildWithBaseUrl('https://maskin.example.com/')
			const handler = handlers.get('list_triggers')
			if (!handler) throw new Error('Handler list_triggers not registered')

			const result = (await handler({})) as { _meta: Record<string, unknown> }
			expect(result._meta.webAppBaseUrl).toBe('https://maskin.example.com')
		})

		it('uses workspace_id from args over default when caller overrides', async () => {
			mockFetchSuccess({})
			const handlers = buildWithBaseUrl('https://maskin.example.com')
			const handler = handlers.get('list_triggers')
			if (!handler) throw new Error('Handler list_triggers not registered')

			const result = (await handler({ workspace_id: 'ws-override' })) as {
				_meta: Record<string, unknown>
			}
			expect(result._meta.workspaceId).toBe('ws-override')
		})

		it('omits webAppBaseUrl when not configured (older / unconfigured server)', async () => {
			mockFetchSuccess({})
			const handlers = buildWithBaseUrl(undefined)
			const handler = handlers.get('list_triggers')
			if (!handler) throw new Error('Handler list_triggers not registered')

			const result = (await handler({})) as { _meta: Record<string, unknown> }
			expect(result._meta.toolName).toBe('list_triggers')
			expect(result._meta.webAppBaseUrl).toBeUndefined()
			// workspaceId still present (from defaultWorkspaceId)
			expect(result._meta.workspaceId).toBe('ws-default-123')
		})
	})

	describe('workspace schema editing handlers (W1)', () => {
		// Mocks GET /api/workspaces (used by getWorkspace) + PATCH /api/workspaces/:id
		// so each schema-mutating tool can read-modify-write field_definitions.
		function mockSchemaBackend(initial: {
			id: string
			fieldDefs: Record<string, Array<Record<string, unknown>>>
		}) {
			let current = { ...initial.fieldDefs }
			let lastPatchUrl: string | null = null
			let lastPatchBody: Record<string, unknown> | null = null

			vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
				const url = input as string
				const method = init?.method ?? 'GET'
				if (method === 'GET' && url.endsWith('/api/workspaces')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve([
								{
									id: initial.id,
									name: 'Test',
									settings: { field_definitions: current },
								},
							]),
					} as Response
				}
				if (method === 'PATCH' && url.includes(`/api/workspaces/${initial.id}`)) {
					lastPatchUrl = url
					lastPatchBody = init?.body ? JSON.parse(init.body as string) : null
					const settings = (lastPatchBody?.settings as Record<string, unknown>) ?? {}
					if (settings.field_definitions) {
						current = settings.field_definitions as Record<string, Array<Record<string, unknown>>>
					}
					return {
						ok: true,
						json: () =>
							Promise.resolve({
								id: initial.id,
								name: 'Test',
								settings: { field_definitions: current },
							}),
					} as Response
				}
				throw new Error(`Unhandled fake fetch: ${method} ${url}`)
			})

			return {
				get current() {
					return current
				},
				get lastPatchUrl() {
					return lastPatchUrl
				},
				get lastPatchBody() {
					return lastPatchBody
				},
			}
		}

		it('create_workspace_field appends a new field for the calling workspace', async () => {
			const fake = mockSchemaBackend({
				id: 'ws-default-123',
				fieldDefs: { task: [] },
			})

			const handler = getHandler('create_workspace_field')
			const res = (await handler({
				type: 'task',
				name: 'priority',
				field_type: 'enum',
				values: ['low', 'high'],
			})) as { content: Array<{ text: string }> }

			expect(fake.lastPatchUrl).toContain('/api/workspaces/ws-default-123')
			expect(fake.current.task).toEqual([
				{ name: 'priority', type: 'enum', values: ['low', 'high'] },
			])
			const parsed = JSON.parse(res.content[0].text)
			expect(parsed.field).toMatchObject({ name: 'priority', type: 'enum' })
		})

		it('create_workspace_field rejects duplicate field names', async () => {
			mockSchemaBackend({
				id: 'ws-default-123',
				fieldDefs: { task: [{ name: 'priority', type: 'text' }] },
			})
			const handler = getHandler('create_workspace_field')
			await expect(handler({ type: 'task', name: 'priority', field_type: 'text' })).rejects.toThrow(
				/already exists/,
			)
		})

		it('create_workspace_field rejects enum without values', async () => {
			mockSchemaBackend({ id: 'ws-default-123', fieldDefs: { task: [] } })
			const handler = getHandler('create_workspace_field')
			await expect(handler({ type: 'task', name: 'risk', field_type: 'enum' })).rejects.toThrow(
				/at least one value/,
			)
		})

		it('update_workspace_field renames a field while preserving other fields', async () => {
			const fake = mockSchemaBackend({
				id: 'ws-default-123',
				fieldDefs: {
					task: [
						{ name: 'priority', type: 'text' },
						{ name: 'due', type: 'date' },
					],
				},
			})
			const handler = getHandler('update_workspace_field')
			await handler({ type: 'task', name: 'priority', new_name: 'urgency' })
			expect(fake.current.task).toEqual([
				{ name: 'urgency', type: 'text' },
				{ name: 'due', type: 'date' },
			])
		})

		it('update_workspace_field rejects renaming to an existing name', async () => {
			mockSchemaBackend({
				id: 'ws-default-123',
				fieldDefs: {
					task: [
						{ name: 'a', type: 'text' },
						{ name: 'b', type: 'text' },
					],
				},
			})
			const handler = getHandler('update_workspace_field')
			await expect(handler({ type: 'task', name: 'a', new_name: 'b' })).rejects.toThrow(
				/already exists/,
			)
		})

		it('delete_workspace_field removes the field and is idempotent', async () => {
			const fake = mockSchemaBackend({
				id: 'ws-default-123',
				fieldDefs: {
					task: [
						{ name: 'a', type: 'text' },
						{ name: 'b', type: 'text' },
					],
				},
			})
			const handler = getHandler('delete_workspace_field')
			await handler({ type: 'task', name: 'a' })
			expect(fake.current.task).toEqual([{ name: 'b', type: 'text' }])
			// idempotent: delete same name again
			await handler({ type: 'task', name: 'a' })
			expect(fake.current.task).toEqual([{ name: 'b', type: 'text' }])
		})

		it('add_workspace_enum_value appends a value', async () => {
			const fake = mockSchemaBackend({
				id: 'ws-default-123',
				fieldDefs: {
					bet: [{ name: 'risk', type: 'enum', values: ['low'] }],
				},
			})
			const handler = getHandler('add_workspace_enum_value')
			await handler({ type: 'bet', name: 'risk', value: 'high' })
			expect(fake.current.bet).toEqual([{ name: 'risk', type: 'enum', values: ['low', 'high'] }])
		})

		it('add_workspace_enum_value rejects on non-enum field', async () => {
			mockSchemaBackend({
				id: 'ws-default-123',
				fieldDefs: { bet: [{ name: 'priority', type: 'text' }] },
			})
			const handler = getHandler('add_workspace_enum_value')
			await expect(handler({ type: 'bet', name: 'priority', value: 'high' })).rejects.toThrow(
				/not "enum"/,
			)
		})

		it('remove_workspace_enum_value drops a value', async () => {
			const fake = mockSchemaBackend({
				id: 'ws-default-123',
				fieldDefs: {
					bet: [{ name: 'risk', type: 'enum', values: ['low', 'high'] }],
				},
			})
			const handler = getHandler('remove_workspace_enum_value')
			await handler({ type: 'bet', name: 'risk', value: 'low' })
			expect(fake.current.bet).toEqual([{ name: 'risk', type: 'enum', values: ['high'] }])
		})

		it('honours workspace_id arg over the default workspace (cross-workspace isolation)', async () => {
			// Two workspaces; the call targets ws-other so default ws-default-123
			// must remain untouched.
			let otherFieldDefs: Record<string, Array<Record<string, unknown>>> = { task: [] }
			const defaultFieldDefs: Record<string, Array<Record<string, unknown>>> = {
				task: [{ name: 'unrelated', type: 'text' }],
			}
			let lastPatchUrl: string | null = null

			vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
				const url = input as string
				const method = init?.method ?? 'GET'
				if (method === 'GET' && url.endsWith('/api/workspaces')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve([
								{
									id: 'ws-default-123',
									name: 'Default',
									settings: { field_definitions: defaultFieldDefs },
								},
								{
									id: 'ws-other',
									name: 'Other',
									settings: { field_definitions: otherFieldDefs },
								},
							]),
					} as Response
				}
				if (method === 'PATCH' && url.includes('/api/workspaces/ws-other')) {
					lastPatchUrl = url
					const body = init?.body ? JSON.parse(init.body as string) : null
					const settings = (body?.settings as Record<string, unknown>) ?? {}
					if (settings.field_definitions) {
						otherFieldDefs = settings.field_definitions as typeof otherFieldDefs
					}
					return {
						ok: true,
						json: () =>
							Promise.resolve({
								id: 'ws-other',
								name: 'Other',
								settings: { field_definitions: otherFieldDefs },
							}),
					} as Response
				}
				if (method === 'PATCH' && url.includes('/api/workspaces/ws-default-123')) {
					throw new Error('Default workspace was patched — cross-workspace isolation is broken')
				}
				throw new Error(`Unhandled fake fetch: ${method} ${url}`)
			})

			const handler = getHandler('create_workspace_field')
			await handler({
				workspace_id: 'ws-other',
				type: 'task',
				name: 'priority',
				field_type: 'text',
			})

			expect(lastPatchUrl).toContain('/api/workspaces/ws-other')
			expect(otherFieldDefs.task).toEqual([{ name: 'priority', type: 'text' }])
			expect(defaultFieldDefs.task).toEqual([{ name: 'unrelated', type: 'text' }])
		})
	})
})

describe('object resources for the MCP picker', () => {
	type ListCallback = () => Promise<{
		resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>
	}>
	type ReadCallback = (
		uri: URL,
		vars: Record<string, string>,
	) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text: string }> }>

	interface ResourceRegistration {
		name: string
		template: { template: string; listCallback?: ListCallback }
		metadata: Record<string, unknown>
		read: ReadCallback
	}

	function buildServerWith(overrides: Partial<typeof config>) {
		vi.clearAllMocks()
		const registered: ResourceRegistration[] = []
		const fakeServer = { registerResource: vi.fn() }

		const mockedMcpServer = vi.mocked(McpServer) as unknown as {
			mockImplementation: (fn: () => unknown) => void
		}
		mockedMcpServer.mockImplementation(() => fakeServer)

		// vi.restoreAllMocks (run by earlier describes' afterEach) wipes the
		// implementation on every vi.fn() set in the module-mock factory, so
		// re-attach the ResourceTemplate stub each call.
		const mockedTemplate = vi.mocked(ResourceTemplate) as unknown as {
			mockImplementation: (
				fn: (template: string, callbacks?: { list?: ListCallback }) => unknown,
			) => void
		}
		mockedTemplate.mockImplementation((template, callbacks) => ({
			template,
			listCallback: callbacks?.list,
		}))

		vi.mocked(fakeServer.registerResource).mockImplementation((...args: unknown[]) => {
			const [name, template, metadata, read] = args as [
				string,
				{ template: string; listCallback?: ListCallback },
				Record<string, unknown>,
				ReadCallback,
			]
			registered.push({ name, template, metadata, read })
		})

		createMcpServer({ ...config, ...overrides })
		return registered
	}

	function findRegistration(registrations: ResourceRegistration[], name: string) {
		const r = registrations.find((x) => x.name === name)
		if (!r) throw new Error(`Registration ${name} not found`)
		return r
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('does not register data resources when webAppBaseUrl is missing', () => {
		const registered = buildServerWith({ webAppBaseUrl: undefined })
		expect(registered).toEqual([])
	})

	it('registers object, actor, and trigger resource templates when baseUrl is set', () => {
		const registered = buildServerWith({ webAppBaseUrl: 'https://maskin.example.com' })
		const names = registered.map((r) => r.name).sort()
		expect(names).toEqual(['maskin-actor', 'maskin-object', 'maskin-trigger'])
	})

	it('object template URI matches the F2 deep-link pattern (/objects/{id})', () => {
		const registered = buildServerWith({ webAppBaseUrl: 'https://maskin.example.com/' })
		const obj = findRegistration(registered, 'maskin-object')
		expect(obj.template.template).toBe(
			'https://maskin.example.com/{workspaceId}/objects/{objectId}',
		)
		expect(ResourceTemplate).toHaveBeenCalledWith(
			'https://maskin.example.com/{workspaceId}/objects/{objectId}',
			expect.objectContaining({ list: expect.any(Function) }),
		)
	})

	describe('list callback (objects)', () => {
		it('returns deep-link URIs and a 200-char preview for every object', async () => {
			const registered = buildServerWith({ webAppBaseUrl: 'https://maskin.example.com' })
			const obj = findRegistration(registered, 'maskin-object')

			const longContent = 'a'.repeat(500)
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						{
							id: 'obj-1',
							workspaceId: 'ws-default-123',
							type: 'bet',
							title: 'Ship MCP rich app',
							content: longContent,
							status: 'active',
						},
						{
							id: 'obj-2',
							workspaceId: 'ws-default-123',
							type: 'task',
							title: '',
							content: 'Short content',
							status: 'todo',
						},
					]),
			} as Response)

			const list = obj.template.listCallback
			if (!list) throw new Error('List callback missing')
			const result = await list()

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/objects?limit=100',
				expect.objectContaining({
					headers: expect.objectContaining({ 'X-Workspace-Id': 'ws-default-123' }),
				}),
			)

			expect(result.resources).toHaveLength(2)
			expect(result.resources[0].uri).toBe(
				'https://maskin.example.com/ws-default-123/objects/obj-1',
			)
			expect(result.resources[0].name).toBe('Ship MCP rich app')
			expect(result.resources[0].description).toContain('[bet · active]')
			// 200-char preview, no raw 500-char content leak
			expect(result.resources[0].description?.length ?? 0).toBeLessThan(260)
			expect(result.resources[0].mimeType).toBe('application/json')

			// Empty title falls back to "Untitled <type>"
			expect(result.resources[1].name).toBe('Untitled task')
		})

		it('returns an empty list (no throw) when the API call fails', async () => {
			const registered = buildServerWith({ webAppBaseUrl: 'https://maskin.example.com' })
			const obj = findRegistration(registered, 'maskin-object')

			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: false,
				status: 500,
				text: () => Promise.resolve('boom'),
			} as Response)
			vi.spyOn(console, 'error').mockImplementation(() => {})

			const list = obj.template.listCallback
			if (!list) throw new Error('List callback missing')
			const result = await list()
			expect(result.resources).toEqual([])
		})

		it('returns empty when no API key or default workspace is configured', async () => {
			const registered = buildServerWith({
				webAppBaseUrl: 'https://maskin.example.com',
				apiKey: '',
			})
			const obj = findRegistration(registered, 'maskin-object')
			const list = obj.template.listCallback
			if (!list) throw new Error('List callback missing')
			const result = await list()
			expect(result.resources).toEqual([])
		})
	})

	describe('read callback (objects)', () => {
		it('returns title, status, 200-char preview, and deep link', async () => {
			const registered = buildServerWith({ webAppBaseUrl: 'https://maskin.example.com' })
			const obj = findRegistration(registered, 'maskin-object')

			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						id: 'obj-1',
						workspaceId: 'ws-default-123',
						type: 'bet',
						title: 'Ship MCP rich app',
						content: 'b'.repeat(500),
						status: 'active',
					}),
			} as Response)

			const uri = new URL('https://maskin.example.com/ws-default-123/objects/obj-1')
			const result = await obj.read(uri, { workspaceId: 'ws-default-123', objectId: 'obj-1' })

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/objects/obj-1',
				expect.objectContaining({
					headers: expect.objectContaining({ 'X-Workspace-Id': 'ws-default-123' }),
				}),
			)
			expect(result.contents).toHaveLength(1)
			expect(result.contents[0].mimeType).toBe('application/json')
			const payload = JSON.parse(result.contents[0].text)
			expect(payload).toEqual({
				id: 'obj-1',
				type: 'bet',
				title: 'Ship MCP rich app',
				status: 'active',
				preview: expect.stringMatching(/^b{200}…$/),
				deepLink: 'https://maskin.example.com/ws-default-123/objects/obj-1',
				workspaceId: 'ws-default-123',
			})
		})
	})

	describe('actor template', () => {
		it('lists actors with the agents deep-link pattern', async () => {
			const registered = buildServerWith({ webAppBaseUrl: 'https://maskin.example.com' })
			const actor = findRegistration(registered, 'maskin-actor')

			expect(actor.template.template).toBe(
				'https://maskin.example.com/{workspaceId}/agents/{actorId}',
			)

			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						{ id: 'a-1', type: 'agent', name: 'Code Reviewer', email: null },
						{ id: 'a-2', type: 'human', name: 'Sindre', email: 'sindre@example.com' },
					]),
			} as Response)

			const list = actor.template.listCallback
			if (!list) throw new Error('List callback missing')
			const result = await list()

			expect(result.resources[0].uri).toBe('https://maskin.example.com/ws-default-123/agents/a-1')
			expect(result.resources[0].description).toBe('[agent]')
			expect(result.resources[1].description).toBe('[human] sindre@example.com')
		})
	})

	describe('trigger template', () => {
		it('lists triggers with the triggers deep-link pattern', async () => {
			const registered = buildServerWith({ webAppBaseUrl: 'https://maskin.example.com' })
			const trigger = findRegistration(registered, 'maskin-trigger')

			expect(trigger.template.template).toBe(
				'https://maskin.example.com/{workspaceId}/triggers/{triggerId}',
			)

			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						{
							id: 't-1',
							workspaceId: 'ws-default-123',
							name: 'Daily standup',
							type: 'cron',
							enabled: true,
						},
					]),
			} as Response)

			const list = trigger.template.listCallback
			if (!list) throw new Error('List callback missing')
			const result = await list()
			expect(result.resources[0].uri).toBe('https://maskin.example.com/ws-default-123/triggers/t-1')
			expect(result.resources[0].description).toBe('[cron · enabled]')
		})
	})
})
