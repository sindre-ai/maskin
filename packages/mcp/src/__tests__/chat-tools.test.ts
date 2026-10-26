import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same scaffold as list-chats.test.ts: intercept registerAppTool so each chat tool's
// handler can be driven directly and the API calls it makes inspected.
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
	defaultWorkspaceId: '00000000-0000-4000-8000-0000000000aa',
	telemetrySink: () => {},
}

const wsId = config.defaultWorkspaceId
const chatId = '33333333-3333-4333-8333-333333333333'
const meId = '11111111-1111-4111-8111-111111111111'
const agentA = '44444444-4444-4444-8444-444444444444'
const agentB = '55555555-5555-4555-8555-555555555555'
const humanId = '22222222-2222-4222-8222-222222222222'

const participants = [
	{ actorId: meId, actorName: 'Me', actorType: 'agent' },
	{ actorId: agentA, actorName: 'Strategist', actorType: 'agent' },
	{ actorId: agentB, actorName: 'Writer', actorType: 'agent' },
	{ actorId: humanId, actorName: 'Magnus', actorType: 'human' },
]

type Call = { method: string; path: string; search: URLSearchParams; body: unknown }

describe('chat tools', () => {
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>
	let calls: Call[]
	// path (without query) → response body, per method
	let responses: Record<string, unknown>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = new Map()
		calls = []
		responses = {}
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
		})
		createMcpServer(config)
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const url = new URL(String(input))
			const method = String(init?.method ?? 'GET')
			calls.push({
				method,
				path: url.pathname,
				search: url.searchParams,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			})
			const body = responses[`${method} ${url.pathname}`]
			if (body === 'no-content') {
				return {
					ok: true,
					status: 204,
					headers: new Headers(),
					json: () => Promise.reject(new Error('no body')),
					text: () => Promise.resolve(''),
				} as Response
			}
			return {
				ok: true,
				status: 200,
				headers: new Headers(),
				json: () => Promise.resolve(body ?? {}),
				text: () => Promise.resolve(JSON.stringify(body ?? {})),
			} as Response
		})
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	function call(name: string, args: Record<string, unknown>) {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`${name} not registered`)
		return handler(args)
	}

	function parsed(result: unknown) {
		const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}'
		return JSON.parse(text) as Record<string, unknown>
	}

	const callsTo = (method: string, path: string) =>
		calls.filter((c) => c.method === method && c.path === path)

	describe('create_chat', () => {
		it('opens a top-level chat with the given title and participants', async () => {
			responses['POST /api/conversations'] = { id: chatId, participants }
			await call('create_chat', {
				workspace_id: wsId,
				title: 'Launch plan',
				participant_actor_ids: [agentA, humanId],
			})
			const [created] = callsTo('POST', '/api/conversations')
			expect(created?.body).toEqual({
				title: 'Launch plan',
				participant_actor_ids: [agentA, humanId],
			})
			expect(callsTo('POST', `/api/conversations/${chatId}/messages`)).toHaveLength(0)
		})

		it('posts the first message and @mentions the agents but not the people', async () => {
			responses['POST /api/conversations'] = { id: chatId, participants }
			responses[`POST /api/conversations/${chatId}/messages`] = { id: 7, actorId: meId }
			await call('create_chat', {
				workspace_id: wsId,
				title: 'Launch plan',
				participant_actor_ids: [agentA, agentB, humanId],
				first_message: 'Draft the launch plan',
			})
			const [posted] = callsTo('POST', `/api/conversations/${chatId}/messages`)
			expect(posted?.body).toMatchObject({
				content: 'Draft the launch plan',
				metadata: { mentions: [agentA, agentB] },
			})
		})

		it('ties the chat to a subject when one is given', async () => {
			responses['POST /api/conversations'] = { id: chatId, participants }
			await call('create_chat', {
				workspace_id: wsId,
				title: 'Bet chat',
				participant_actor_ids: [agentA],
				subject_type: 'object',
				subject_id: agentB,
			})
			const [created] = callsTo('POST', '/api/conversations')
			expect(created?.body).toMatchObject({ subject: { type: 'object', id: agentB } })
		})

		it('refuses a subject_type without a subject_id', async () => {
			await expect(
				call('create_chat', {
					workspace_id: wsId,
					title: 'Bet chat',
					participant_actor_ids: [agentA],
					subject_type: 'object',
				}),
			).rejects.toThrow(/go together/)
			expect(calls).toHaveLength(0)
		})
	})

	describe('add_chat_participant / remove_chat_participant', () => {
		it('adds the actors to the chat', async () => {
			responses[`POST /api/conversations/${chatId}/participants`] = participants
			await call('add_chat_participant', { conversation_id: chatId, actor_ids: [agentA, agentB] })
			const [added] = callsTo('POST', `/api/conversations/${chatId}/participants`)
			expect(added?.body).toEqual({ actor_ids: [agentA, agentB] })
		})

		it('removes one participant, though the route answers with no body', async () => {
			responses[`DELETE /api/conversations/${chatId}/participants/${agentA}`] = 'no-content'
			const result = parsed(
				await call('remove_chat_participant', { conversation_id: chatId, actor_id: agentA }),
			)
			expect(result).toEqual({ removed: true, actor_id: agentA })
			expect(callsTo('DELETE', `/api/conversations/${chatId}/participants/${agentA}`)).toHaveLength(
				1,
			)
		})
	})

	describe('get_conversation', () => {
		it('says which agents have a live session and leaves people alone', async () => {
			responses[`GET /api/conversations/${chatId}`] = { id: chatId, participants }
			responses['GET /api/sessions'] = [
				{ id: 's1', actorId: agentA, status: 'running' },
				{ id: 's0', actorId: agentA, status: 'completed' },
				{ id: 's2', actorId: agentB, status: 'failed' },
			]
			const result = parsed(await call('get_conversation', { conversation_id: chatId })) as {
				participants: Array<{ actorId: string; status?: string }>
			}
			const status = (id: string) => result.participants.find((p) => p.actorId === id)?.status
			expect(status(agentA)).toBe('running')
			expect(status(agentB)).toBe('not_running')
			expect(status(meId)).toBe('not_running')
			expect(status(humanId)).toBeUndefined()
			expect(calls.find((c) => c.path === '/api/sessions')?.search.get('conversation_id')).toBe(
				chatId,
			)
		})
	})

	describe('stop_chat_agent', () => {
		it('stops only the live sessions of that agent in that chat', async () => {
			responses['GET /api/sessions'] = [
				{ id: 's1', actorId: agentA, status: 'running' },
				{ id: 's2', actorId: agentB, status: 'running' },
				{ id: 's3', actorId: agentA, status: 'completed' },
			]
			const result = parsed(
				await call('stop_chat_agent', { conversation_id: chatId, actor_id: agentA }),
			)
			expect(result).toEqual({ stopped: true, session_ids: ['s1'] })
			expect(callsTo('POST', '/api/sessions/s1/stop')).toHaveLength(1)
			expect(callsTo('POST', '/api/sessions/s2/stop')).toHaveLength(0)
			expect(callsTo('POST', '/api/sessions/s3/stop')).toHaveLength(0)
		})

		it('says so when the agent has nothing running', async () => {
			responses['GET /api/sessions'] = [{ id: 's3', actorId: agentA, status: 'completed' }]
			const result = parsed(
				await call('stop_chat_agent', { conversation_id: chatId, actor_id: agentA }),
			)
			expect(result.stopped).toBe(false)
			expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
		})

		it('stops a sub-chat by its session id', async () => {
			await call('stop_chat_agent', { session_id: 's9' })
			expect(callsTo('POST', '/api/sessions/s9/stop')).toHaveLength(1)
		})

		it('needs a chat and an agent, or a session', async () => {
			await expect(call('stop_chat_agent', { conversation_id: chatId })).rejects.toThrow(/actor_id/)
		})
	})

	describe('get_chat_activity', () => {
		it('returns the latest run of each agent in the chat, with its status', async () => {
			responses['GET /api/sessions'] = [
				{ id: 's1', actorId: agentA, status: 'running' },
				{ id: 's0', actorId: agentA, status: 'completed' },
				{ id: 's2', actorId: agentB, status: 'completed' },
			]
			responses['GET /api/sessions/s1/activity'] = { turns: ['a'] }
			responses['GET /api/sessions/s2/activity'] = { turns: ['b'] }
			const result = (await call('get_chat_activity', {
				workspace_id: wsId,
				conversation_id: chatId,
				limit_turns: 2,
			})) as { structuredContent: { agents: Array<Record<string, unknown>> } }
			const agents = result.structuredContent.agents
			expect(agents.map((a) => a.session_id).sort()).toEqual(['s1', 's2'])
			expect(agents.find((a) => a.actor_id === agentA)).toMatchObject({
				status: 'running',
				activity: { turns: ['a'] },
			})
			expect(callsTo('GET', '/api/sessions/s1/activity')[0]?.search.get('limit_turns')).toBe('2')
		})

		it('narrows to one agent', async () => {
			responses['GET /api/sessions'] = [
				{ id: 's1', actorId: agentA, status: 'running' },
				{ id: 's2', actorId: agentB, status: 'running' },
			]
			const result = (await call('get_chat_activity', {
				workspace_id: wsId,
				conversation_id: chatId,
				actor_id: agentB,
			})) as { structuredContent: { agents: Array<Record<string, unknown>> } }
			expect(result.structuredContent.agents.map((a) => a.actor_id)).toEqual([agentB])
		})

		it('needs a chat or a sub-chat', async () => {
			await expect(call('get_chat_activity', { workspace_id: wsId })).rejects.toThrow(
				/conversation_id/,
			)
		})
	})

	describe('create_sub_chat', () => {
		it('starts the agent like create_session and registers the result to come back', async () => {
			responses['POST /api/sessions'] = { id: 's1', actorId: agentA, status: 'pending' }
			await call('create_sub_chat', {
				workspace_id: wsId,
				actor_id: agentA,
				action_prompt: 'Review the draft',
			})
			const [created] = callsTo('POST', '/api/sessions')
			expect(created?.body).toMatchObject({
				actor_id: agentA,
				action_prompt: 'Review the draft',
				notify_on_complete: true,
			})
		})

		it('keeps create_session working under the old name', () => {
			expect(handlers.has('create_session')).toBe(true)
			expect(handlers.has('create_sub_chat')).toBe(true)
		})
	})

	describe('post_conversation_message wait', () => {
		it('holds until the mentioned agent posts its closing message', async () => {
			vi.useFakeTimers()
			responses[`POST /api/conversations/${chatId}/messages`] = { id: 100, actorId: meId }
			responses[`GET /api/conversations/${chatId}`] = { id: chatId, participants }
			responses[`GET /api/conversations/${chatId}/messages`] = {
				messages: [
					{
						id: 103,
						actorId: agentA,
						content: 'Here is the plan',
						metadata: { source: 'final_output' },
					},
					{ id: 101, actorId: agentA, content: 'On it', metadata: null },
					{ id: 102, actorId: agentB, content: 'Not asked', metadata: { source: 'final_output' } },
				],
			}
			const pending = call('post_conversation_message', {
				workspace_id: wsId,
				conversation_id: chatId,
				content: 'Please plan',
				metadata: { mentions: [agentA] },
				wait: true,
			})
			await vi.advanceTimersByTimeAsync(6_000)
			const result = parsed(await pending) as {
				wait: { settled: boolean; replies: Array<{ id: number }> }
			}
			expect(result.wait.settled).toBe(true)
			// Only the agent that was asked, oldest first, interim notes included.
			expect(result.wait.replies.map((r) => r.id)).toEqual([101, 103])
			expect(
				callsTo('GET', `/api/conversations/${chatId}/messages`)[0]?.search.get('after_id'),
			).toBe('100')
		})

		it('does not wait when there is no agent to wait for', async () => {
			responses[`POST /api/conversations/${chatId}/messages`] = { id: 100, actorId: meId }
			responses[`GET /api/conversations/${chatId}`] = {
				id: chatId,
				participants: participants.filter((p) => p.actorType === 'human' || p.actorId === meId),
			}
			const result = parsed(
				await call('post_conversation_message', {
					workspace_id: wsId,
					conversation_id: chatId,
					content: 'Anyone there?',
					wait: true,
				}),
			) as { wait: { note: string } }
			expect(result.wait.note).toMatch(/no agent/)
			expect(callsTo('GET', `/api/conversations/${chatId}/messages`)).toHaveLength(0)
		})

		it('posts and returns at once when wait is not set', async () => {
			responses[`POST /api/conversations/${chatId}/messages`] = { id: 100, actorId: meId }
			const result = parsed(
				await call('post_conversation_message', {
					workspace_id: wsId,
					conversation_id: chatId,
					content: 'Heads up',
				}),
			)
			expect(result.wait).toBeUndefined()
			expect(calls).toHaveLength(1)
		})
	})

	describe('list_chats subject filter', () => {
		it('passes subject_type and subject_id to the API', async () => {
			responses['GET /api/conversations'] = { conversations: [], has_more: false }
			await call('list_chats', { subject_type: 'object', subject_id: agentB })
			const [listed] = callsTo('GET', '/api/conversations')
			expect(listed?.search.get('subject_type')).toBe('object')
			expect(listed?.search.get('subject_id')).toBe(agentB)
		})
	})
})
