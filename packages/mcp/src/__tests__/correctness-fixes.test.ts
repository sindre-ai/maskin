import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same mocking envelope as cursor-pagination.test.ts — stubs the SDK + ext-apps
// + node:fs so `createMcpServer` wires up without side effects and every
// registered handler is captured in a Map for direct invocation.
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
import { tools } from '../tools'

const wsId = '00000000-0000-0000-0000-0000000000aa'
const objectId = '550e8400-e29b-41d4-a716-446655440000'
const otherObjectId = '550e8400-e29b-41d4-a716-446655440001'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey',
	defaultWorkspaceId: wsId,
	webAppBaseUrl: 'https://maskin.io',
	telemetrySink: () => {},
}

type Handler = (args: Record<string, unknown>) => Promise<unknown>
type ToolResponse = {
	content: Array<{ text: string }>
	structuredContent?: Record<string, unknown> & { next_cursor?: string }
}

function registerHandlers(cfg: typeof config): Map<string, Handler> {
	const handlers = new Map<string, Handler>()
	vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
		handlers.set(name as string, handler as Handler)
	})
	createMcpServer(cfg)
	return handlers
}

function jsonResponse(body: unknown): Response {
	return { ok: true, headers: new Headers(), json: () => Promise.resolve(body) } as Response
}

describe('MCP correctness fixes', () => {
	let handlers: Map<string, Handler>

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		handlers = registerHandlers(config)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	function getHandler(name: string): Handler {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`handler ${name} not registered`)
		return handler
	}

	describe('events paging (get_events / get_comments)', () => {
		const TOTAL = 130
		const BASE = Date.UTC(2026, 5, 1)

		// Newest first by index: event 0 is the newest, event TOTAL-1 the oldest.
		// Every third event belongs to a different object and is a different action
		// so the filters have something to exclude.
		const history = Array.from({ length: TOTAL }, (_, i) => ({
			id: 1000 + i,
			workspaceId: wsId,
			action: i % 3 === 0 ? 'created' : 'commented',
			entityType: 'object',
			entityId: i % 3 === 0 ? otherObjectId : objectId,
			data: {},
			createdAt: new Date(BASE - i * 1000).toISOString(),
		}))

		// Fake of GET /api/events/history: newest first, honours limit, before,
		// entity_id, entity_type and action, and never returns more than 100 rows,
		// exactly like the real route.
		function stubHistoryApi() {
			return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
				const url = new URL(String(input))
				const q = url.searchParams
				const limit = Math.min(Number(q.get('limit') ?? 50), 100)
				const before = q.get('before')
				const rows = history
					.filter((e) => !q.get('entity_id') || e.entityId === q.get('entity_id'))
					.filter((e) => !q.get('entity_type') || e.entityType === q.get('entity_type'))
					.filter((e) => !q.get('action') || e.action === q.get('action'))
					.filter((e) => !before || e.createdAt < new Date(before).toISOString())
					.slice(0, limit)
				return jsonResponse(rows)
			})
		}

		async function walk(tool: string, args: Record<string, unknown>, rowsField: string) {
			const seen: Array<{ id: number }> = []
			let cursor: string | undefined
			let pages = 0
			do {
				const res = (await getHandler(tool)({ ...args, cursor })) as ToolResponse
				seen.push(...((res.structuredContent?.[rowsField] as Array<{ id: number }>) ?? []))
				cursor = res.structuredContent?.next_cursor
				pages += 1
				if (pages > 20) throw new Error('walk did not terminate')
			} while (cursor)
			return { seen, pages }
		}

		it('get_events walks the whole history with no gaps or duplicates', async () => {
			stubHistoryApi()
			const { seen, pages } = await walk('get_events', { limit: 50 }, 'events')

			expect(pages).toBe(3)
			expect(seen.map((e) => e.id)).toEqual(history.map((e) => e.id))
		})

		it('get_events reaches events older than the newest 100 rows', async () => {
			stubHistoryApi()
			const first = (await getHandler('get_events')({ limit: 98 })) as ToolResponse
			const second = (await getHandler('get_events')({
				limit: 98,
				cursor: first.structuredContent?.next_cursor,
			})) as ToolResponse

			const secondIds = (second.structuredContent?.events as Array<{ id: number }>).map((e) => e.id)
			expect(secondIds).toEqual(history.slice(98).map((e) => e.id))
			expect(second.structuredContent?.next_cursor).toBeUndefined()
		})

		it('get_comments walks every comment on the object', async () => {
			stubHistoryApi()
			const { seen } = await walk('get_comments', { entity_id: objectId, limit: 20 }, 'comments')

			const expected = history.filter((e) => e.entityId === objectId && e.action === 'commented')
			expect(expected.length).toBeGreaterThan(40)
			expect(seen.map((e) => e.id)).toEqual(expected.map((e) => e.id))
		})

		it('asks the API only for rows older than the cursor on later pages', async () => {
			const fetchSpy = stubHistoryApi()
			const first = (await getHandler('get_events')({ limit: 50 })) as ToolResponse
			await getHandler('get_events')({ limit: 50, cursor: first.structuredContent?.next_cursor })

			const [firstUrl, secondUrl] = fetchSpy.mock.calls.map(([u]) => new URL(String(u)))
			// Page size plus one sentinel row, and no time bound on the first call.
			expect(firstUrl.searchParams.get('limit')).toBe('51')
			expect(firstUrl.searchParams.has('before')).toBe(false)
			expect(secondUrl.searchParams.get('before')).not.toBeNull()
		})

		it('get_events forwards entity_id to the API', async () => {
			const fetchSpy = stubHistoryApi()
			const res = (await getHandler('get_events')({
				entity_id: objectId,
				action: 'commented',
				limit: 10,
			})) as ToolResponse

			const url = new URL(String(fetchSpy.mock.calls[0][0]))
			expect(url.searchParams.get('entity_id')).toBe(objectId)
			const rows = res.structuredContent?.events as Array<{ entityId: string }>
			expect(rows.length).toBe(10)
			expect(rows.every((r) => r.entityId === objectId)).toBe(true)
		})

		it('get_events declares an entity_id input', () => {
			expect(tools.get_events.inputSchema.shape.entity_id).toBeDefined()
			expect(tools.get_events.inputSchema.safeParse({ entity_id: objectId }).success).toBe(true)
			const badId = tools.get_events.inputSchema.safeParse({ entity_id: 'not-a-uuid' })
			expect(badId.success).toBe(false)
		})
	})

	describe('get_workspace_schema: unknown workspace id', () => {
		const workspaces = [
			{ id: 'ws-first', name: 'First', settings: { statuses: { bet: ['active'] } } },
			{ id: 'ws-second', name: 'Second', settings: { statuses: { task: ['todo'] } } },
		]

		type ErrorResponse = {
			isError?: boolean
			structuredContent?: { error?: { reason: string } }
		}

		it('returns a not-found error instead of the first workspace', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(workspaces))

			const res = (await getHandler('get_workspace_schema')({
				workspace_id: 'ws-missing',
			})) as ErrorResponse
			expect(res.isError).toBe(true)
			expect(res.structuredContent?.error?.reason).toContain('Workspace not found: ws-missing')
		})

		it('returns a not-found error when the default id is not in the list either', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(workspaces))

			const res = (await getHandler('get_workspace_schema')({})) as ErrorResponse
			expect(res.isError).toBe(true)
			expect(res.structuredContent?.error?.reason).toContain(`Workspace not found: ${wsId}`)
		})

		it('returns the requested workspace when the id matches', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(workspaces))

			const res = (await getHandler('get_workspace_schema')({
				workspace_id: 'ws-second',
			})) as ToolResponse
			const parsed = JSON.parse(res.content[0].text) as { types: Record<string, unknown> }
			expect(Object.keys(parsed.types)).toContain('task')
			expect(Object.keys(parsed.types)).not.toContain('bet')
		})

		it('falls back to the first workspace only when no id is given at all', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(workspaces))
			const noDefault = registerHandlers({ ...config, defaultWorkspaceId: '' })

			const res = (await noDefault.get('get_workspace_schema')?.({})) as ToolResponse
			const parsed = JSON.parse(res.content[0].text) as { types: Record<string, unknown> }
			expect(Object.keys(parsed.types)).toContain('bet')
		})
	})

	describe('run_agent: waiting_for_input', () => {
		it('returns as soon as the session waits for input, with the logs and a message', async () => {
			vi.useFakeTimers()
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce(jsonResponse({ id: 'sess-w1', status: 'pending' }))
				.mockResolvedValueOnce(jsonResponse({ id: 'sess-w1', status: 'waiting_for_input' }))
				.mockResolvedValueOnce(jsonResponse([{ message: 'Which branch?' }]))

			const resultPromise = getHandler('run_agent')({
				actor_id: 'actor-1',
				action_prompt: 'Needs a human answer',
				poll_interval_seconds: 5,
				timeout_seconds: 660,
			})
			// One poll interval, nowhere near the 660 s timeout.
			await vi.advanceTimersByTimeAsync(5000)

			const result = (await resultPromise) as ToolResponse
			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.session.status).toBe('waiting_for_input')
			expect(parsed.waiting_for_input).toBe(true)
			expect(parsed.message).toContain('sess-w1')
			expect(parsed.logs).toEqual([{ message: 'Which branch?' }])
			// create, one poll, logs: no further polling.
			expect(fetchSpy).toHaveBeenCalledTimes(3)
		})

		it('does not flag a session that finished normally', async () => {
			vi.useFakeTimers()
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce(jsonResponse({ id: 'sess-w2', status: 'pending' }))
				.mockResolvedValueOnce(jsonResponse({ id: 'sess-w2', status: 'completed' }))
				.mockResolvedValueOnce(jsonResponse([]))

			const resultPromise = getHandler('run_agent')({
				actor_id: 'actor-1',
				action_prompt: 'Quick task',
				poll_interval_seconds: 5,
			})
			await vi.advanceTimersByTimeAsync(5000)

			const parsed = JSON.parse(((await resultPromise) as ToolResponse).content[0].text)
			expect(parsed.session.status).toBe('completed')
			expect(parsed).not.toHaveProperty('waiting_for_input')
		})
	})

	describe('list_sessions status filter', () => {
		it('accepts queued and waiting_for_input', () => {
			const schema = tools.list_sessions.inputSchema
			expect(schema.safeParse({ status: 'queued' }).success).toBe(true)
			expect(schema.safeParse({ status: 'waiting_for_input' }).success).toBe(true)
			expect(schema.safeParse({ status: 'not-a-status' }).success).toBe(false)
		})
	})

	describe('relationship tool descriptions', () => {
		it('create_relationship no longer claims delete_relationship is not exposed', () => {
			expect(tools.create_relationship.description).not.toMatch(/does not expose/i)
			expect(tools.create_relationship.description).toContain('delete_relationship')
		})

		it('delete_relationship says it is destructive and permanent', () => {
			expect(tools.delete_relationship.description).toMatch(/destructive/i)
			expect(tools.delete_relationship.description).toMatch(/permanent/i)
		})
	})
})
