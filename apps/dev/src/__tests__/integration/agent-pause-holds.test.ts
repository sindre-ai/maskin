import { EventEmitter } from 'node:events'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, messages, notifications, workspaceMembers } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// A person's Pause must hold against chat messages and @mentions, while the idle
// watcher's auto-pause (the same agentState) keeps waking the agent. The marker
// is told apart in actors.metadata, so these run against real Postgres.

vi.mock('../../lib/analytics/group-chat-routing-events', () => ({
	trackGroupChatMessageRouted: vi.fn(),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

import { isHumanPaused, notHumanPaused, withoutHumanPauseMarker } from '../../lib/agent-pause'
import { evaluateAndRespond } from '../../services/conversation-responder'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { CommentDispatcher } from '../../services/trigger-runner'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}

function makeSessionManager() {
	return {
		enqueueSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
		createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
		findActiveConversationSession: vi.fn().mockResolvedValue(null),
		findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
		drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn().mockResolvedValue(undefined),
		markSessionFailedAfterContainerLoss: vi.fn().mockResolvedValue(undefined),
		stopSession: vi.fn(),
		pauseSession: vi.fn(),
		resumeSession: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
	}
}
type SessionManagerStub = ReturnType<typeof makeSessionManager>

const sessionStarts = (sm: SessionManagerStub) =>
	sm.enqueueSession.mock.calls.length + sm.createSession.mock.calls.length
// A turn written into a session that is already live also spends the agent's tokens.
const turnsDelivered = (sm: SessionManagerStub) =>
	sessionStarts(sm) + sm.writeInput.mock.calls.length

async function agentMetadata(agentId: string) {
	const [row] = await db
		.select({ agentState: actors.agentState, metadata: actors.metadata })
		.from(actors)
		.where(eq(actors.id, agentId))
	return row
}

describe('A person-paused agent', () => {
	let ownerId: string
	let workspaceId: string
	let sm: SessionManagerStub

	beforeEach(async () => {
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
		sm = makeSessionManager()
		configureSessionLifecycle({ db, sessionManager: sm as unknown as SessionManager })
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	async function agent(name: string, overrides: Record<string, unknown> = {}) {
		const row = await insertActor(db, { type: 'agent', name, ...overrides })
		await db.insert(workspaceMembers).values({ workspaceId, actorId: row.id, role: 'member' })
		return row
	}

	const pauseRoute = (id: string) =>
		createIntegrationApp({ path: '/api/actors', module: actorsRoutes }).request(
			jsonRequest('POST', `/api/actors/${id}/pause`, undefined, { 'x-workspace-id': workspaceId }),
		)
	const runRoute = (id: string) =>
		createIntegrationApp({ path: '/api/actors', module: actorsRoutes }).request(
			jsonRequest('POST', `/api/actors/${id}/run`, {}, { 'x-workspace-id': workspaceId }),
		)

	async function chatWith(others: Array<{ id: string }>) {
		const app = new OpenAPIHono<Env>({
			defaultHook: (result, c) =>
				result.success
					? undefined
					: c.json(
							createApiError('VALIDATION_ERROR', 'invalid', formatZodError(result.error)),
							400,
						),
		})
		app.use('*', async (c, next) => {
			c.set('db', db)
			c.set('actorId', ownerId)
			c.set('actorType', 'human')
			c.set('sessionManager', sm)
			await next()
		})
		app.route('/api/conversations', conversationsRoutes)
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/conversations',
				{ title: 'Pause', participant_actor_ids: others.map((o) => o.id) },
				{ 'x-workspace-id': workspaceId },
			),
		)
		return ((await res.json()) as { id: string }).id
	}

	/** The human posts a message and the responder runs, as the messages route does. */
	async function say(conversationId: string, content: string, mentions: string[] = []) {
		const [row] = await db
			.insert(messages)
			.values({
				conversationId,
				actorId: ownerId,
				content,
				metadata: mentions.length > 0 ? { mentions } : null,
			})
			.returning()
		if (!row) throw new Error('failed to insert message')
		await evaluateAndRespond({
			db,
			sessionManager: sm as unknown as SessionManager,
			workspaceId,
			conversationId,
			messageId: row.id,
		})
		return row.id
	}

	const conversationLines = (conversationId: string) =>
		db
			.select({ kind: messages.kind, content: messages.content, actorId: messages.actorId })
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
			.orderBy(messages.id)

	describe('the Pause and Run routes', () => {
		it('Pause marks the pause as a person’s and Run clears it, keeping other metadata', async () => {
			const bot = await agent('Bot')
			await db
				.update(actors)
				.set({ metadata: { voice_enabled: true } })
				.where(eq(actors.id, bot.id))

			expect((await pauseRoute(bot.id)).status).toBe(200)
			expect(await agentMetadata(bot.id)).toEqual({
				agentState: 'paused',
				metadata: { voice_enabled: true, paused_by: 'human' },
			})

			// A live session keeps Run from starting a new one; it only syncs the state.
			await insertSession(db, workspaceId, bot.id, ownerId, { status: 'queued' })
			expect((await runRoute(bot.id)).status).toBe(200)
			expect(await agentMetadata(bot.id)).toEqual({
				agentState: 'running',
				metadata: { voice_enabled: true },
			})
		})

		it('the idle watcher’s paused write drops a stale marker and keeps other metadata', async () => {
			const bot = await agent('Bot')
			await db
				.update(actors)
				.set({ agentState: 'paused', metadata: { voice_enabled: true, paused_by: 'human' } })
				.where(eq(actors.id, bot.id))

			await db
				.update(actors)
				.set({ agentState: 'paused', metadata: withoutHumanPauseMarker })
				.where(eq(actors.id, bot.id))

			expect((await agentMetadata(bot.id))?.metadata).toEqual({ voice_enabled: true })
		})

		it('the idle watcher’s write skips a person’s pause and lands once it is resumed', async () => {
			const bot = await agent('Bot')
			const watcherWrite = () =>
				db
					.update(actors)
					.set({ agentState: 'paused', metadata: withoutHumanPauseMarker })
					.where(and(eq(actors.id, bot.id), notHumanPaused))
					.returning({ id: actors.id })

			// A person pressed Pause between the watcher's check and its write.
			await pauseRoute(bot.id)
			expect(await watcherWrite()).toHaveLength(0)
			expect((await agentMetadata(bot.id))?.metadata).toMatchObject({ paused_by: 'human' })

			// Resumed: the watcher's pause lands, as an auto-pause with no marker.
			await runRoute(bot.id)
			expect(await watcherWrite()).toHaveLength(1)
			const resumed = await agentMetadata(bot.id)
			expect(resumed && isHumanPaused(resumed)).toBe(false)
		})
	})

	describe('in a direct chat', () => {
		it('gets no session and no turn, the message stays, and the chat says why', async () => {
			const bot = await agent('Bot')
			await pauseRoute(bot.id)
			const conversationId = await chatWith([bot])

			await say(conversationId, 'are you there?')

			expect(turnsDelivered(sm)).toBe(0)
			const lines = await conversationLines(conversationId)
			expect(lines.map((l) => [l.kind, l.content])).toEqual([
				['message', 'are you there?'],
				['system', 'Bot is paused, resume to reply'],
			])
		})

		it('gets no turn written into a session that is still live', async () => {
			const bot = await agent('Bot')
			await pauseRoute(bot.id)
			sm.findConversationSessionAnyActive.mockResolvedValue({
				id: crypto.randomUUID(),
				status: 'running',
				workspaceId,
			})
			const conversationId = await chatWith([bot])

			await say(conversationId, 'still there?')

			expect(sm.writeInput).not.toHaveBeenCalled()
			expect(turnsDelivered(sm)).toBe(0)
		})

		it('still wakes when only the idle watcher paused it', async () => {
			const bot = await agent('Bot')
			await db
				.update(actors)
				.set({ agentState: 'paused', agentStateUpdatedAt: new Date() })
				.where(eq(actors.id, bot.id))
			const conversationId = await chatWith([bot])

			await say(conversationId, 'are you there?')

			expect(turnsDelivered(sm)).toBe(1)
			const lines = await conversationLines(conversationId)
			expect(lines.every((l) => l.kind === 'message')).toBe(true)
		})

		it('wakes again after Run', async () => {
			const bot = await agent('Bot')
			await pauseRoute(bot.id)
			await insertSession(db, workspaceId, bot.id, ownerId, { status: 'queued' })
			await runRoute(bot.id)
			const conversationId = await chatWith([bot])

			await say(conversationId, 'welcome back')

			// The queued session above is the agent's, but the stub reports no live
			// conversation session, so the responder starts one.
			expect(turnsDelivered(sm)).toBe(1)
		})
	})

	describe('in a group chat', () => {
		it('stays silent when tagged, and the chat says why', async () => {
			const paused = await agent('Pausey')
			const other = await agent('Other')
			await pauseRoute(paused.id)
			const conversationId = await chatWith([paused, other])

			await say(conversationId, 'Pausey, can you look?', [paused.id])

			expect(turnsDelivered(sm)).toBe(0)
			const lines = await conversationLines(conversationId)
			expect(lines.filter((l) => l.kind === 'system').map((l) => l.content)).toEqual([
				'Pausey is paused, resume to reply',
			])
		})

		it('adds no line for a paused member nobody addressed', async () => {
			const paused = await agent('Pausey')
			const other = await agent('Other')
			await pauseRoute(paused.id)
			const conversationId = await chatWith([paused, other])

			await say(conversationId, 'Other, can you look?', [other.id])

			expect(turnsDelivered(sm)).toBe(1)
			const lines = await conversationLines(conversationId)
			expect(lines.some((l) => l.kind === 'system')).toBe(false)
		})
	})

	describe('on the @mention path', () => {
		let bridge: EventEmitter & PgNotifyBridge
		let dispatcher: CommentDispatcher

		beforeEach(() => {
			bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
			dispatcher = new CommentDispatcher(db, bridge, sm as unknown as SessionManager)
			dispatcher.start()
		})

		afterEach(() => {
			dispatcher.stop()
		})

		async function mention(agentId: string) {
			const object = await insertObject(db, workspaceId, ownerId, { type: 'task', title: 'look' })
			const [row] = await db
				.insert(events)
				.values({
					workspaceId,
					actorId: ownerId,
					action: 'commented',
					entityType: 'object',
					entityId: object.id,
					data: { content: 'please take a look', mentions: [agentId] },
				})
				.returning({ id: events.id })
			const event: PgEvent = {
				workspace_id: workspaceId,
				actor_id: ownerId,
				action: 'commented',
				entity_type: 'object',
				entity_id: object.id,
				event_id: String(row.id),
			}
			bridge.emit('event', event)
			// dispatchMention starts the session without awaiting it.
			await new Promise((r) => setTimeout(r, 500))
			return object.id
		}

		it('starts no session, and the mention is still waiting as a notification', async () => {
			const bot = await agent('Bot')
			await pauseRoute(bot.id)

			const objectId = await mention(bot.id)

			expect(sessionStarts(sm)).toBe(0)
			const rows = await db
				.select()
				.from(notifications)
				.where(and(eq(notifications.targetActorId, bot.id), eq(notifications.objectId, objectId)))
			expect(rows).toHaveLength(1)
		})

		it('still starts a session when only the idle watcher paused it', async () => {
			const bot = await agent('Bot')
			await db
				.update(actors)
				.set({ agentState: 'paused', agentStateUpdatedAt: new Date() })
				.where(eq(actors.id, bot.id))

			await mention(bot.id)

			expect(sessionStarts(sm)).toBe(1)
		})
	})

	describe('on the comment fallback path (no @mention)', () => {
		let bridge: EventEmitter & PgNotifyBridge
		let dispatcher: CommentDispatcher

		beforeEach(() => {
			bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
			dispatcher = new CommentDispatcher(db, bridge, sm as unknown as SessionManager)
			dispatcher.start()
		})

		afterEach(() => {
			dispatcher.stop()
		})

		/** A person comments with no mention on an object, and the fallback ladder runs. */
		async function commentOn(driverId: string | null) {
			const object = await insertObject(db, workspaceId, ownerId, {
				type: 'task',
				title: 'look',
				driver: driverId,
			})
			const [row] = await db
				.insert(events)
				.values({
					workspaceId,
					actorId: ownerId,
					action: 'commented',
					entityType: 'object',
					entityId: object.id,
					data: { content: 'any news on this?' },
				})
				.returning({ id: events.id })
			const event: PgEvent = {
				workspace_id: workspaceId,
				actor_id: ownerId,
				action: 'commented',
				entity_type: 'object',
				entity_id: object.id,
				event_id: String(row.id),
			}
			bridge.emit('event', event)
			await new Promise((r) => setTimeout(r, 500))
		}

		const autoPause = (id: string) =>
			db
				.update(actors)
				.set({ agentState: 'paused', agentStateUpdatedAt: new Date() })
				.where(eq(actors.id, id))

		it('starts no session for a paused driver', async () => {
			const driver = await agent('Driver')
			await pauseRoute(driver.id)

			await commentOn(driver.id)

			expect(sessionStarts(sm)).toBe(0)
		})

		it('starts no session for a paused Chief of Staff', async () => {
			const cos = await agent('Chief of Staff')
			await pauseRoute(cos.id)

			await commentOn(null)

			expect(sessionStarts(sm)).toBe(0)
		})

		it('still starts a session for a driver only the idle watcher paused', async () => {
			const driver = await agent('Driver')
			await autoPause(driver.id)

			await commentOn(driver.id)

			expect(sessionStarts(sm)).toBe(1)
		})

		it('still starts a session for a Chief of Staff only the idle watcher paused', async () => {
			const cos = await agent('Chief of Staff')
			await autoPause(cos.id)

			await commentOn(null)

			expect(sessionStarts(sm)).toBe(1)
		})
	})
})
