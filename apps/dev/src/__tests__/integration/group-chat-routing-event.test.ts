import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { messages, workspaceMembers } from '@maskin/db/schema'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { track, chat } = vi.hoisted(() => ({ track: vi.fn(), chat: vi.fn() }))

vi.mock('../../lib/analytics/group-chat-routing-events', () => ({
	trackGroupChatMessageRouted: track,
}))
vi.mock('../../lib/llm/index', () => ({ createLLMAdapter: () => ({ chat }) }))

import { evaluateAndRespond } from '../../services/conversation-responder'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'

const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}
type Outcome = { agentId: string; decision: string; reason: string; delivery: string }
type Routed = Record<string, unknown> & {
	trigger: string
	taggedActorIds: string[]
	outcomes: Outcome[]
}

function makeSessionManager() {
	return {
		createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
		findActiveConversationSession: vi.fn().mockResolvedValue(null),
		findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
		drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn().mockResolvedValue(undefined),
		markSessionFailedAfterContainerLoss: vi.fn().mockResolvedValue(undefined),
	}
}

const lastRouted = () => track.mock.calls[track.mock.calls.length - 1]?.[0] as Routed
const flush = () => new Promise((resolve) => setTimeout(resolve, 150))

describe('group_chat_message_routed', () => {
	let ownerId: string
	let workspaceId: string

	beforeEach(async () => {
		vi.clearAllMocks()
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
	})

	async function actor(type: 'agent' | 'human', overrides: Record<string, unknown> = {}) {
		const row = await insertActor(db, { type, ...overrides })
		if (!row) throw new Error('actor insert failed')
		await db.insert(workspaceMembers).values({ workspaceId, actorId: row.id, role: 'member' })
		return row
	}

	/** The owner plus the given actors, created through the real route. */
	async function chatWith(others: Array<{ id: string }>, sessionManager = makeSessionManager()) {
		const app = new OpenAPIHono<Env>({
			defaultHook: (result, c) =>
				result.success
					? undefined
					: c.json(
							createApiError('VALIDATION_ERROR', 'invalid', formatZodError(result.error)),
							400,
						),
		})
		configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
		app.use('*', async (c, next) => {
			c.set('db', db)
			c.set('actorId', ownerId)
			c.set('actorType', 'human')
			c.set('sessionManager', sessionManager)
			await next()
		})
		app.route('/api/conversations', conversationsRoutes)
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/conversations',
				{ title: 'Routing', participant_actor_ids: others.map((o) => o.id) },
				{ 'x-workspace-id': workspaceId },
			),
		)
		const conversationId = ((await res.json()) as { id: string }).id
		return { app, sessionManager, conversationId }
	}

	async function post(
		conversationId: string,
		actorId: string,
		content: string,
		mentions?: string[],
	) {
		const [row] = await db
			.insert(messages)
			.values({ conversationId, actorId, content, metadata: mentions ? { mentions } : null })
			.returning()
		if (!row) throw new Error('failed to insert message')
		return row.id
	}

	async function respond(
		sessionManager: ReturnType<typeof makeSessionManager>,
		conversationId: string,
		messageId: number,
	) {
		return evaluateAndRespond({
			db,
			// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
			sessionManager: sessionManager as any,
			workspaceId,
			conversationId,
			messageId,
		})
	}

	const api = (
		app: { request: (r: Request) => Promise<Response> },
		method: string,
		path: string,
		body?: unknown,
	) => app.request(jsonRequest(method, path, body, { 'x-workspace-id': workspaceId }))

	describe('what it records', () => {
		it('emits one event per message with ids and counts only, including the legacy default-yes wakes', async () => {
			const [a, b] = [await actor('agent'), await actor('agent')]
			const person = await actor('human')
			const { sessionManager, conversationId } = await chatWith([a, b, person])
			await post(conversationId, a.id, 'agent spoke first')
			const messageId = await post(conversationId, ownerId, 'secret text', [b.id, person.id])

			await respond(sessionManager, conversationId, messageId)
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))
			await flush()

			expect(track).toHaveBeenCalledTimes(1)
			const e = lastRouted()
			expect(e).toMatchObject({
				trigger: 'new_message',
				authorType: 'human',
				participantCount: 4,
				agentParticipantCount: 2,
				candidateCount: 2,
				taggedAgentIds: [b.id],
				taggedHumanCount: 1,
				previousOtherActorId: a.id,
				capHit: false,
			})
			expect(e.taggedActorIds.sort()).toEqual([b.id, person.id].sort())
			const reasons = Object.fromEntries(e.outcomes.map((o) => [o.agentId, o.reason]))
			// A is not tagged and has no chat-callable key, so the check fails open.
			expect(reasons).toEqual({ [a.id]: 'default_yes_no_credentials', [b.id]: 'tagged' })
			expect(JSON.stringify(e)).not.toContain('secret text')
		})

		it('emits when the model says no and nobody is woken', async () => {
			const keyed = { llmProvider: 'anthropic', llmConfig: { api_key: 'sk-test' } }
			const [a, b] = [await actor('agent', keyed), await actor('agent', keyed)]
			chat.mockResolvedValue({
				tool_calls: [{ name: 'decide_response', arguments: { should_respond: false } }],
			})
			const { sessionManager, conversationId } = await chatWith([a, b])
			const messageId = await post(conversationId, ownerId, 'just thinking out loud')

			await respond(sessionManager, conversationId, messageId)
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))

			expect(lastRouted().outcomes).toEqual([
				expect.objectContaining({ decision: 'skip', reason: 'model_no', delivery: 'none' }),
				expect.objectContaining({ decision: 'skip', reason: 'model_no', delivery: 'none' }),
			])
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('emits on the cap path with dropped_agent_cap for every candidate', async () => {
			const [a, b] = [await actor('agent'), await actor('agent')]
			const { sessionManager, conversationId } = await chatWith([a, b])
			for (let i = 0; i < 5; i++) await post(conversationId, a.id, `agent turn ${i}`)
			const messageId = await post(conversationId, b.id, 'still there?', [a.id])

			expect(await respond(sessionManager, conversationId, messageId)).toBe('agent_cap')
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))

			expect(lastRouted()).toMatchObject({ capHit: true, authorType: 'agent', candidateCount: 1 })
			expect(lastRouted().outcomes).toEqual([
				{ agentId: a.id, decision: 'skip', reason: 'dropped_agent_cap', delivery: 'none' },
			])
		})
	})

	describe('when it stays silent', () => {
		it('emits nothing in a direct chat', async () => {
			const agent = await actor('agent')
			const { sessionManager, conversationId } = await chatWith([agent])
			await respond(sessionManager, conversationId, await post(conversationId, ownerId, 'hi'))
			await flush()

			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			expect(track).not.toHaveBeenCalled()
		})

		it('emits nothing in a group chat with no candidate agent', async () => {
			const people = [await actor('human'), await actor('human')]
			const { sessionManager, conversationId } = await chatWith(people)
			await respond(
				sessionManager,
				conversationId,
				await post(conversationId, ownerId, 'people only'),
			)
			await flush()

			expect(track).not.toHaveBeenCalled()
		})
	})

	it('reads the trigger correctly at each of the four call sites', async () => {
		const [x, y] = [await actor('agent'), await actor('agent')]
		const { app, conversationId } = await chatWith([x, y])
		const triggers = async (n: number) => {
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(n))
			return lastRouted().trigger
		}

		await api(app, 'POST', '/api/conversations', {
			title: 'First message',
			participant_actor_ids: [x.id, y.id],
			initial_message: 'kick off',
		})
		expect(await triggers(1)).toBe('new_message')

		await api(app, 'POST', `/api/conversations/${conversationId}/messages`, { content: 'next' })
		expect(await triggers(2)).toBe('new_message')

		const messageId = await post(conversationId, ownerId, 'typo here')
		const messagePath = `/api/conversations/${conversationId}/messages/${messageId}`
		await api(app, 'PATCH', messagePath, { content: 'typo fixed' })
		expect(await triggers(3)).toBe('edit')

		await api(app, 'POST', `${messagePath}/retry`)
		expect(await triggers(4)).toBe('retry')
		expect(lastRouted().outcomes.map((o) => o.reason)).toEqual(['forced_retry', 'forced_retry'])

		await api(app, 'POST', `${messagePath}/retry?agent_id=${x.id}`)
		expect(await triggers(5)).toBe('redo')
		expect(lastRouted().outcomes.map((o) => o.agentId)).toEqual([x.id])
	})

	describe('delivery', () => {
		const session = (status: string) => ({ id: crypto.randomUUID(), status, workspaceId: '' })
		const race = Object.assign(new Error('duplicate'), {
			code: '23505',
			constraint_name: 'sessions_conversation_actor_active_uniq',
		})

		it.each([
			['started_new_session when no session exists', () => {}, 'started_new_session'],
			[
				'wrote_to_running_session when a session is running',
				(sm: ReturnType<typeof makeSessionManager>) =>
					sm.findConversationSessionAnyActive.mockResolvedValue(session('running')),
				'wrote_to_running_session',
			],
			[
				'buffered_for_booting_session when the session is still starting',
				(sm: ReturnType<typeof makeSessionManager>) =>
					sm.findConversationSessionAnyActive.mockResolvedValue(session('starting')),
				'buffered_for_booting_session',
			],
			[
				'started_new_session when a dead session is replaced',
				(sm: ReturnType<typeof makeSessionManager>) => {
					sm.findConversationSessionAnyActive.mockResolvedValue(session('running'))
					sm.writeInput.mockRejectedValue(new Error('stdin detached'))
				},
				'started_new_session',
			],
			[
				'joined_race_winner when the start loses the race',
				(sm: ReturnType<typeof makeSessionManager>) => {
					sm.createSession.mockRejectedValue(race)
					sm.findConversationSessionAnyActive
						.mockResolvedValueOnce(null)
						.mockResolvedValue(session('running'))
				},
				'joined_race_winner',
			],
			[
				'start_failed when the session cannot be started',
				(sm: ReturnType<typeof makeSessionManager>) =>
					sm.createSession.mockRejectedValue(new Error('no capacity')),
				'start_failed',
			],
		])('%s', async (_name, arrange, delivery) => {
			const sm = makeSessionManager()
			arrange(sm)
			const [agent, person] = [await actor('agent'), await actor('human')]
			const { conversationId } = await chatWith([agent, person], sm)
			const messageId = await post(conversationId, ownerId, 'hey', [agent.id])

			await respond(sm, conversationId, messageId)
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))

			expect(lastRouted().outcomes.map((o) => `${o.reason}|${o.delivery}`)).toEqual([
				`tagged|${delivery}`,
			])
		})
	})
})
