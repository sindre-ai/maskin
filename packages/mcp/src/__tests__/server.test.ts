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
			'ui://maskin/generic',
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
})
