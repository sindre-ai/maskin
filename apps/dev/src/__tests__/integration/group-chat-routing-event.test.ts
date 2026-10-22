import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversationParticipants, messages, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
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

function createApp(actorId: string, sessionManager = makeSessionManager()) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('sessionManager', sessionManager)
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return { app, sessionManager }
}

async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 150))
}

type Routed = {
	workspaceId: string
	conversationId: string
	messageId: number
	trigger: string
	authorActorId: string
	authorType: string
	participantCount: number
	agentParticipantCount: number
	candidateCount: number
	taggedActorIds: string[]
	taggedAgentIds: string[]
	taggedHumanCount: number
	previousOtherActorId: string
	outcomes: Array<{ agentId: string; decision: string; reason: string; delivery: string }>
	capHit: boolean
}

function lastRouted(): Routed {
	const call = track.mock.calls[track.mock.calls.length - 1]
	if (!call) throw new Error('no routing event was emitted')
	return call[0] as Routed
}

describe('group_chat_message_routed', () => {
	let ownerId: string
	let workspaceId: string

	beforeEach(async () => {
		vi.clearAllMocks()
		ownerId = getTestActorId()
		const ws = await insertWorkspace(db, ownerId)
		workspaceId = ws.id
	})

	async function addMember(actorId: string) {
		await db.insert(workspaceMembers).values({ workspaceId, actorId, role: 'member' })
	}

	/** Owner plus the given actors, created through the real route. */
	async function createChat(app: ReturnType<typeof createApp>['app'], others: string[]) {
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/conversations',
				{ title: 'Routing', participant_actor_ids: others },
				{ 'x-workspace-id': workspaceId },
			),
		)
		return ((await res.json()) as { id: string }).id
	}

	async function post(
		conversationId: string,
		actorId: string,
		content: string,
		mentions?: string[],
	) {
		const [row] = await db
			.insert(messages)
			.values({
				conversationId,
				actorId,
				content,
				metadata: mentions ? { mentions } : null,
			})
			.returning()
		if (!row) throw new Error('failed to insert message')
		return row.id
	}

	async function twoAgentChat() {
		const agentA = await insertActor(db, { type: 'agent' })
		const agentB = await insertActor(db, { type: 'agent' })
		if (!agentA || !agentB) throw new Error('actor insert failed')
		await addMember(agentA.id)
		await addMember(agentB.id)
		const { app, sessionManager } = createApp(ownerId)
		const conversationId = await createChat(app, [agentA.id, agentB.id])
		return { app, sessionManager, conversationId, agentA, agentB }
	}

	describe('when it emits', () => {
		it('emits exactly one event for an untagged message, with only ids, counts and flat values', async () => {
			const { sessionManager, conversationId, agentA, agentB } = await twoAgentChat()
			const messageId = await post(conversationId, ownerId, 'secret message text, who else?')

			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId,
				messageId,
			})
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))
			await flush()
			expect(track).toHaveBeenCalledTimes(1)

			const e = lastRouted()
			expect(e).toMatchObject({
				workspaceId,
				conversationId,
				messageId,
				trigger: 'new_message',
				authorActorId: ownerId,
				authorType: 'human',
				participantCount: 3,
				agentParticipantCount: 2,
				candidateCount: 2,
				taggedActorIds: [],
				taggedAgentIds: [],
				taggedHumanCount: 0,
				previousOtherActorId: '',
				capHit: false,
			})
			// No agent has a chat-callable key here, so the relevance check fails open:
			// both are woken by default, which is the wrong wake this event exists to count.
			expect(
				e.outcomes.map((o) => `${o.agentId}|${o.decision}|${o.reason}|${o.delivery}`).sort(),
			).toEqual(
				[
					`${agentA.id}|wake|default_yes_no_credentials|started_new_session`,
					`${agentB.id}|wake|default_yes_no_credentials|started_new_session`,
				].sort(),
			)
			// Nothing in the payload carries message text.
			expect(JSON.stringify(e)).not.toContain('secret message text')
			expect(sessionManager.createSession).toHaveBeenCalledTimes(2)
		})

		it('reports a tagged agent as tagged and still runs the legacy check for the other', async () => {
			const { sessionManager, conversationId, agentA, agentB } = await twoAgentChat()
			const messageId = await post(conversationId, ownerId, 'hey A', [agentA.id])

			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId,
				messageId,
			})
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))

			const e = lastRouted()
			expect(e.taggedActorIds).toEqual([agentA.id])
			expect(e.taggedAgentIds).toEqual([agentA.id])
			expect(e.taggedHumanCount).toBe(0)
			const byAgent = Object.fromEntries(e.outcomes.map((o) => [o.agentId, o.reason]))
			expect(byAgent[agentA.id]).toBe('tagged')
			expect(byAgent[agentB.id]).toBe('default_yes_no_credentials')
		})

		it('counts a tagged person and records the previous other writer', async () => {
			const person = await insertActor(db, { type: 'human' })
			const agent = await insertActor(db, { type: 'agent' })
			if (!person || !agent) throw new Error('actor insert failed')
			await addMember(person.id)
			await addMember(agent.id)
			const { app, sessionManager } = createApp(ownerId)
			const conversationId = await createChat(app, [person.id, agent.id])
			await post(conversationId, agent.id, 'agent spoke first')
			const messageId = await post(conversationId, ownerId, 'over to you', [person.id])

			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId,
				messageId,
			})
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))

			const e = lastRouted()
			expect(e.taggedActorIds).toEqual([person.id])
			expect(e.taggedAgentIds).toEqual([])
			expect(e.taggedHumanCount).toBe(1)
			expect(e.previousOtherActorId).toBe(agent.id)
			expect(e.agentParticipantCount).toBe(1)
		})

		it('emits when the model says no and nobody is woken (silence is visible)', async () => {
			const agentA = await insertActor(db, {
				type: 'agent',
				llmProvider: 'anthropic',
				llmConfig: { api_key: 'sk-test' },
			})
			const agentB = await insertActor(db, {
				type: 'agent',
				llmProvider: 'anthropic',
				llmConfig: { api_key: 'sk-test' },
			})
			if (!agentA || !agentB) throw new Error('actor insert failed')
			await addMember(agentA.id)
			await addMember(agentB.id)
			chat.mockResolvedValue({
				tool_calls: [{ name: 'decide_response', arguments: { should_respond: false } }],
			})
			const { app, sessionManager } = createApp(ownerId)
			const conversationId = await createChat(app, [agentA.id, agentB.id])
			const messageId = await post(conversationId, ownerId, 'just talking to myself')

			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId,
				messageId,
			})
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))

			const e = lastRouted()
			expect(e.outcomes.every((o) => o.decision === 'skip' && o.reason === 'model_no')).toBe(true)
			expect(e.outcomes.every((o) => o.delivery === 'none')).toBe(true)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('emits on the cap path with dropped_agent_cap for every candidate', async () => {
			const { sessionManager, conversationId, agentA, agentB } = await twoAgentChat()
			for (let i = 0; i < 5; i++) await post(conversationId, agentA.id, `agent turn ${i}`)
			const messageId = await post(conversationId, agentB.id, 'still there?', [agentA.id])

			const result = await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId,
				messageId,
			})
			expect(result).toBe('agent_cap')
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))

			const e = lastRouted()
			expect(e.capHit).toBe(true)
			expect(e.authorType).toBe('agent')
			expect(e.candidateCount).toBe(1)
			expect(e.outcomes).toEqual([
				{ agentId: agentA.id, decision: 'skip', reason: 'dropped_agent_cap', delivery: 'none' },
			])
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})
	})

	describe('when it stays silent', () => {
		it('emits nothing in a direct chat (exactly 2 active participants)', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			if (!agent) throw new Error('actor insert failed')
			await addMember(agent.id)
			const { app, sessionManager } = createApp(ownerId)
			const conversationId = await createChat(app, [agent.id])
			const messageId = await post(conversationId, ownerId, 'hi')

			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId,
				messageId,
			})
			await flush()

			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			expect(track).not.toHaveBeenCalled()
		})

		it('emits nothing in a group chat with no candidate agent', async () => {
			const personA = await insertActor(db, { type: 'human' })
			const personB = await insertActor(db, { type: 'human' })
			if (!personA || !personB) throw new Error('actor insert failed')
			await addMember(personA.id)
			await addMember(personB.id)
			const { app, sessionManager } = createApp(ownerId)
			const conversationId = await createChat(app, [personA.id, personB.id])
			const messageId = await post(conversationId, ownerId, 'people only')

			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId,
				messageId,
			})
			await flush()

			expect(track).not.toHaveBeenCalled()
		})

		it('does not count a participant who left', async () => {
			const { sessionManager, conversationId, agentA, agentB } = await twoAgentChat()
			await db
				.update(conversationParticipants)
				.set({ leftAt: new Date() })
				.where(
					and(
						eq(conversationParticipants.conversationId, conversationId),
						eq(conversationParticipants.actorId, agentB.id),
					),
				)
			const messageId = await post(conversationId, ownerId, 'hello')

			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId,
				messageId,
			})
			await flush()

			// Owner plus one agent is now a direct chat: nothing is emitted, B is not woken.
			expect(track).not.toHaveBeenCalled()
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			expect(sessionManager.createSession.mock.calls[0]?.[1]).toMatchObject({ actorId: agentA.id })
		})
	})

	describe('trigger at each call site', () => {
		it('reads new_message for create-with-first-message and for post message', async () => {
			const agentA = await insertActor(db, { type: 'agent' })
			const agentB = await insertActor(db, { type: 'agent' })
			if (!agentA || !agentB) throw new Error('actor insert failed')
			await addMember(agentA.id)
			await addMember(agentB.id)
			const { app } = createApp(ownerId)

			const created = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{
						title: 'First message',
						participant_actor_ids: [agentA.id, agentB.id],
						initial_message: 'kick off',
					},
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversationId = ((await created.json()) as { id: string }).id
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))
			expect(lastRouted().trigger).toBe('new_message')

			await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversationId}/messages`,
					{ content: 'second one' },
					{ 'x-workspace-id': workspaceId },
				),
			)
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(2))
			expect(lastRouted().trigger).toBe('new_message')
		})

		it('reads edit when the newest message is edited', async () => {
			const { app, conversationId } = await twoAgentChat()
			const messageId = await post(conversationId, ownerId, 'typo here')

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversationId}/messages/${messageId}`,
					{ content: 'typo fixed' },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(200)
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))
			expect(lastRouted().trigger).toBe('edit')
		})

		it('reads retry for a retry with no target and redo for a retry aimed at one agent', async () => {
			const { app, conversationId, agentA } = await twoAgentChat()
			const messageId = await post(conversationId, ownerId, 'anyone there?')

			await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversationId}/messages/${messageId}/retry`,
					undefined,
					{ 'x-workspace-id': workspaceId },
				),
			)
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))
			const retry = lastRouted()
			expect(retry.trigger).toBe('retry')
			expect(retry.outcomes.map((o) => o.reason)).toEqual(['forced_retry', 'forced_retry'])

			await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversationId}/messages/${messageId}/retry?agent_id=${agentA.id}`,
					undefined,
					{ 'x-workspace-id': workspaceId },
				),
			)
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(2))
			const redo = lastRouted()
			expect(redo.trigger).toBe('redo')
			expect(redo.candidateCount).toBe(1)
			expect(redo.outcomes.map((o) => o.agentId)).toEqual([agentA.id])
		})
	})

	describe('delivery', () => {
		async function singleWake(sessionManager: ReturnType<typeof makeSessionManager>) {
			const agentA = await insertActor(db, { type: 'agent' })
			const person = await insertActor(db, { type: 'human' })
			if (!agentA || !person) throw new Error('actor insert failed')
			await addMember(agentA.id)
			await addMember(person.id)
			const { app } = createApp(ownerId, sessionManager)
			const conversationId = await createChat(app, [agentA.id, person.id])
			const messageId = await post(conversationId, ownerId, 'hey', [agentA.id])
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId,
				messageId,
			})
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))
			return lastRouted().outcomes
		}

		it('started_new_session when no session exists', async () => {
			const outcomes = await singleWake(makeSessionManager())
			expect(outcomes.map((o) => o.delivery)).toEqual(['started_new_session'])
		})

		it('wrote_to_running_session when the agent already has a running session', async () => {
			const sm = makeSessionManager()
			sm.findConversationSessionAnyActive.mockResolvedValue({
				id: crypto.randomUUID(),
				status: 'running',
				workspaceId,
			})
			const outcomes = await singleWake(sm)
			expect(outcomes.map((o) => o.delivery)).toEqual(['wrote_to_running_session'])
			expect(sm.createSession).not.toHaveBeenCalled()
		})

		it('buffered_for_booting_session when the agent session is still starting', async () => {
			const sm = makeSessionManager()
			sm.findConversationSessionAnyActive.mockResolvedValue({
				id: crypto.randomUUID(),
				status: 'starting',
				workspaceId,
			})
			const outcomes = await singleWake(sm)
			expect(outcomes.map((o) => o.delivery)).toEqual(['buffered_for_booting_session'])
		})

		it('started_new_session when a dead session is replaced', async () => {
			const sm = makeSessionManager()
			sm.findConversationSessionAnyActive.mockResolvedValue({
				id: crypto.randomUUID(),
				status: 'running',
				workspaceId,
			})
			sm.writeInput.mockRejectedValue(new Error('stdin detached'))
			const outcomes = await singleWake(sm)
			expect(outcomes.map((o) => o.delivery)).toEqual(['started_new_session'])
			expect(sm.markSessionFailedAfterContainerLoss).toHaveBeenCalledTimes(1)
		})

		it('joined_race_winner when the session start loses the race and the winner takes the turn', async () => {
			const sm = makeSessionManager()
			sm.createSession.mockRejectedValue(
				Object.assign(new Error('duplicate'), {
					code: '23505',
					constraint_name: 'sessions_conversation_actor_active_uniq',
				}),
			)
			sm.findConversationSessionAnyActive
				.mockResolvedValueOnce(null)
				.mockResolvedValue({ id: crypto.randomUUID(), status: 'running', workspaceId })
			const outcomes = await singleWake(sm)
			expect(outcomes.map((o) => o.delivery)).toEqual(['joined_race_winner'])
		})

		it('start_failed when the session cannot be started', async () => {
			const sm = makeSessionManager()
			sm.createSession.mockRejectedValue(new Error('no capacity'))
			const outcomes = await singleWake(sm)
			expect(outcomes).toEqual([
				expect.objectContaining({ decision: 'wake', reason: 'tagged', delivery: 'start_failed' }),
			])
		})
	})

	it('never delays or breaks a wake when the capture fails', async () => {
		track.mockRejectedValueOnce(new Error('posthog down'))
		const { sessionManager, conversationId } = await twoAgentChat()
		const messageId = await post(conversationId, ownerId, 'hello')

		await expect(
			evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId,
				messageId,
			}),
		).resolves.toBeUndefined()
		expect(sessionManager.createSession).toHaveBeenCalledTimes(2)
	})
})
