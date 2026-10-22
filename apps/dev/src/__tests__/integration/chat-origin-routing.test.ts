import { EventEmitter } from 'node:events'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	conversationParticipants,
	messages,
	notifications,
	sessions,
} from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { planCommentRouting } from '../../services/chat-origin-routing'
import { returnToSender } from '../../services/helper-return'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import { SessionManager } from '../../services/session-manager'
import { CommentDispatcher } from '../../services/trigger-runner'
import {
	ensureWorkspaceMember,
	insertActor,
	insertConversation,
	insertObject,
	insertSession,
	insertWorkspace,
} from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db } from './global-setup'

// A comment an agent posts about work a person started in a 1-1 chat comes back
// in that chat instead of For You, unless it carries a decision block or
// attention 4 and above. Real Postgres, the real events, sessions and
// subscriptions routes, and the real CommentDispatcher for the notification side.

const capturePosthogEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: (...args: unknown[]) => capturePosthogEvent(...args),
}))

const { default: eventsRoutes } = await import('../../routes/events')
const { default: sessionsRoutes } = await import('../../routes/sessions')
const { default: subscriptionsRoutes } = await import('../../routes/subscriptions')
const { default: conversationsRoutes } = await import('../../routes/conversations')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: SessionManager
		maskinSessionId?: string
	}
}

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

// A decision block that passes validateDecisionProse.
const DECISION = {
	title: 'Is the onboarding bet worth running?',
	summary:
		'3 of 5 signups stall on step 2, costing about 40 activations a week. I have drafted the replacement copy and the migration.',
	ask: 'This changes what every new customer sees first, so I will not ship it alone.',
	options: [
		{
			label: '7-day window',
			recommended: true,
			consequences: ['Ships with cycle 1 tomorrow', 'Adds 18 support tickets in week one'],
		},
		{
			label: 'Hold',
			consequences: ['Nothing ships this cycle', 'Keeps losing 40 activations a week'],
		},
	],
}

let manager: SessionManager
let app: OpenAPIHono<Env>
let bridge: EventEmitter & PgNotifyBridge
let dispatcher: CommentDispatcher
let created: Array<{ actorId: string; config: Record<string, unknown> }>

beforeAll(() => {
	manager = new SessionManager(db, stubStorage())
	app = new OpenAPIHono<Env>()
	// Stands in for authMiddleware: the acting actor is named in headers.
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', c.req.header('X-Test-Actor-Id') as string)
		c.set('actorType', c.req.header('X-Test-Actor-Type') ?? 'agent')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', {
			stopSession: async () => {},
			createSession: async () => ({}),
		} as unknown as SessionManager)
		const raw = c.req.header('X-Maskin-Session-Id')?.trim()
		if (raw && UUID_RE.test(raw)) c.set('maskinSessionId', raw)
		await next()
	})
	app.route('/api/events', eventsRoutes as never)
	app.route('/api/sessions', sessionsRoutes as never)
	app.route('/api/subscriptions', subscriptionsRoutes as never)
	app.route('/api/conversations', conversationsRoutes as never)
})

afterAll(async () => {
	await manager.stop()
})

type Fixture = Awaited<ReturnType<typeof seed>>
/** The fixture plus sessions the rule 4 and 5 cases point the header at. */
type KeepCtx = Fixture & {
	otherSessionId: string
	elsewhereSessionId: string
	foreignChatSessionId: string
}

/**
 * A person H, an agent A that H has a 1-1 chat with, and A's sessions: one that
 * is the chat session, one helper stamped with the chat, one started by cron.
 */
async function seed() {
	const human = await insertActor(db, { type: 'human', name: 'Sam Rivers' })
	const ws = await insertWorkspace(db, human.id, { enterpriseGranted: true })
	const mkAgent = (name: string) =>
		insertActor(db, {
			type: 'agent',
			name,
			email: `${name}-${Math.random().toString(36).slice(2)}@integration.test`,
			apiKey: `ank_${name}_${Math.random().toString(36).slice(2)}`,
		})
	const [agent, other] = await Promise.all([mkAgent('Chief'), mkAgent('Other')])
	// Both agents belong to the workspace, as they would in a real one: starting a
	// session for an agent requires membership.
	await ensureWorkspaceMember(db, ws.id, agent.id)
	await ensureWorkspaceMember(db, ws.id, other.id)
	const chat = await insertConversation(db, ws.id, human.id)
	await db.insert(conversationParticipants).values([
		{ conversationId: chat.id, actorId: human.id, addedBy: human.id },
		{ conversationId: chat.id, actorId: agent.id, addedBy: human.id },
	])
	const live = { status: 'running' }
	const chatSession = await insertSession(db, ws.id, agent.id, human.id, {
		...live,
		conversationId: chat.id,
		interactive: true,
	})
	const helperSession = await insertSession(db, ws.id, agent.id, agent.id, {
		...live,
		config: { origin_conversation_id: chat.id },
	})
	const askOnlySession = await insertSession(db, ws.id, agent.id, agent.id, {
		...live,
		config: { ask_conversation_id: chat.id },
	})
	const cronSession = await insertSession(db, ws.id, agent.id, agent.id, { ...live, config: {} })
	const object = await insertObject(db, ws.id, human.id, { type: 'task', title: 'Backfill report' })
	return {
		human,
		ws,
		agent,
		other,
		chat,
		chatSession,
		helperSession,
		askOnlySession,
		cronSession,
		object,
	}
}

type PostOver = {
	as?: string
	asType?: string
	session?: string | null
	mentions?: string[]
	decision?: unknown
	attention?: number
	content?: string
}

async function postComment(f: Fixture, over: PostOver = {}) {
	const res = await app.request(
		jsonRequest(
			'POST',
			'/api/events',
			{
				entity_id: f.object.id,
				content: over.content ?? 'Backfill finished, 12 rows updated.',
				mentions: over.mentions ?? [f.human.id],
				...(over.decision ? { decision: over.decision } : {}),
				...(over.attention !== undefined ? { attention: over.attention } : {}),
			},
			{
				'X-Workspace-Id': f.ws.id,
				'X-Test-Actor-Id': over.as ?? f.agent.id,
				'X-Test-Actor-Type': over.asType ?? 'agent',
				...(over.session ? { 'X-Maskin-Session-Id': over.session } : {}),
			},
		),
	)
	expect(res.status).toBe(201)
	const body = (await res.json()) as { id: number }
	const [row] = await db.select().from(events).where(eq(events.id, body.id))
	return { id: body.id, data: (row?.data ?? {}) as { mentions?: string[] } }
}

const chatMessages = (conversationId: string) =>
	db.select().from(messages).where(eq(messages.conversationId, conversationId))

async function forYouEntityIds(f: Fixture) {
	const res = await app.request(
		jsonGet('/api/subscriptions/unread', {
			'X-Workspace-Id': f.ws.id,
			'X-Test-Actor-Id': f.human.id,
			'X-Test-Actor-Type': 'human',
		}),
	)
	expect(res.status).toBe(200)
	const body = (await res.json()) as { items: Array<{ entity_id: string }> }
	return body.items.map((i) => i.entity_id)
}

async function chatUnreadCount(f: Fixture) {
	const res = await app.request(
		jsonGet('/api/conversations', {
			'X-Workspace-Id': f.ws.id,
			'X-Test-Actor-Id': f.human.id,
			'X-Test-Actor-Type': 'human',
		}),
	)
	const body = (await res.json()) as {
		conversations: Array<{ id: string; unread_count: number }>
	}
	return body.conversations.find((c) => c.id === f.chat.id)?.unread_count
}

/** Hands the stored comment to the dispatcher, as the PG notify bridge would. */
async function dispatch(f: Fixture, commentId: number, actorId = f.agent.id) {
	bridge.emit('event', {
		workspace_id: f.ws.id,
		actor_id: actorId,
		action: 'commented',
		entity_type: 'object',
		entity_id: f.object.id,
		event_id: String(commentId),
	} satisfies PgEvent)
	await new Promise((r) => setTimeout(r, 400))
}

const needsInputFor = (humanId: string) =>
	db
		.select()
		.from(notifications)
		.where(and(eq(notifications.targetActorId, humanId), eq(notifications.type, 'needs_input')))

beforeEach(() => {
	capturePosthogEvent.mockClear()
	created = []
	bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
	const sm = {
		enqueueSession: vi.fn(),
		createSession: vi.fn(async (ws: string, params: Record<string, unknown>) => {
			created.push({
				actorId: params.actorId as string,
				config: (params.config ?? {}) as Record<string, unknown>,
			})
			return insertSession(db, ws, params.actorId as string, params.createdBy as string, {
				status: 'completed',
				config: (params.config ?? {}) as object,
			})
		}),
		stopSession: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
	}
	configureSessionLifecycle({ db, sessionManager: sm as unknown as SessionManager })
	dispatcher = new CommentDispatcher(db, bridge, sm as unknown as SessionManager)
	dispatcher.start()
})

afterEach(() => dispatcher.stop())

describe('origin stamp on spawned sessions', () => {
	// The real SessionManager, so the config column write is covered too.
	beforeEach(() => {
		configureSessionLifecycle({ db, sessionManager: manager })
	})

	async function spawn(f: Fixture, asActor: string, senderSessionId: string | null) {
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/sessions',
				{ actor_id: f.other.id, action_prompt: 'help me', auto_start: false },
				{
					'X-Workspace-Id': f.ws.id,
					'X-Test-Actor-Id': asActor,
					...(senderSessionId ? { 'X-Maskin-Session-Id': senderSessionId } : {}),
				},
			),
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as { id: string }
		const [row] = await db.select().from(sessions).where(eq(sessions.id, body.id))
		return (row?.config ?? {}) as { origin_conversation_id?: string }
	}

	it('a helper started through create_session from a chat session carries the chat', async () => {
		const f = await seed()
		const config = await spawn(f, f.agent.id, f.chatSession.id)
		expect(config.origin_conversation_id).toBe(f.chat.id)
	})

	it('a sub-helper inherits it: chat to helper to sub-helper', async () => {
		const f = await seed()
		const helperConfig = await spawn(f, f.agent.id, f.chatSession.id)
		// The helper becomes the next sender, as the other agent.
		const helper = await insertSession(db, f.ws.id, f.other.id, f.agent.id, {
			status: 'running',
			config: helperConfig,
		})
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/sessions',
				{ actor_id: f.agent.id, action_prompt: 'and again', auto_start: false },
				{
					'X-Workspace-Id': f.ws.id,
					'X-Test-Actor-Id': f.other.id,
					'X-Maskin-Session-Id': helper.id,
				},
			),
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as { id: string }
		const [row] = await db.select().from(sessions).where(eq(sessions.id, body.id))
		expect((row?.config as { origin_conversation_id?: string }).origin_conversation_id).toBe(
			f.chat.id,
		)
	})

	it('a sender that only carries ask_conversation_id still hands its chat on', async () => {
		const f = await seed()
		const config = await spawn(f, f.agent.id, f.askOnlySession.id)
		expect(config.origin_conversation_id).toBe(f.chat.id)
	})

	it('a session started by cron gets none, and nor does a call with no header', async () => {
		const f = await seed()
		expect((await spawn(f, f.agent.id, f.cronSession.id)).origin_conversation_id).toBeUndefined()
		expect((await spawn(f, f.agent.id, null)).origin_conversation_id).toBeUndefined()
	})
})

describe('helper return default for work started from a chat', () => {
	beforeEach(() => {
		configureSessionLifecycle({ db, sessionManager: manager })
	})

	async function spawnHelper(
		f: Fixture,
		senderSessionId: string | null,
		extra: Record<string, unknown> = {},
	) {
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/sessions',
				{
					actor_id: f.other.id,
					action_prompt: 'help me',
					auto_start: false,
					initiated_from_object_id: f.object.id,
					...extra,
				},
				{
					'X-Workspace-Id': f.ws.id,
					'X-Test-Actor-Id': f.agent.id,
					...(senderSessionId ? { 'X-Maskin-Session-Id': senderSessionId } : {}),
				},
			),
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as { id: string }
		const [row] = await db.select().from(sessions).where(eq(sessions.id, body.id))
		const config = (row?.config ?? {}) as { notify_on_complete?: boolean }
		return { id: body.id, notify: config.notify_on_complete }
	}

	it('a helper started from a chat session that sets nothing returns into the chat, not the object', async () => {
		const f = await seed()
		const helper = await spawnHelper(f, f.chatSession.id)
		expect(helper.notify).toBe(true)

		await db.update(sessions).set({ status: 'completed' }).where(eq(sessions.id, helper.id))
		const out = await returnToSender(db, helper.id)

		expect(out).toEqual({ returned: true, destination: 'conversation' })
		const inChat = await chatMessages(f.chat.id)
		expect(inChat.filter((m) => m.actorId === f.other.id)).toHaveLength(1)
		const onObject = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, f.object.id), eq(events.action, 'commented')))
		expect(onObject).toHaveLength(0)
	})

	it('an explicit notify_on_complete false from the caller is kept', async () => {
		const f = await seed()
		const helper = await spawnHelper(f, f.chatSession.id, { notify_on_complete: false })
		expect(helper.notify).toBeUndefined()
	})

	it('an explicit notify_on_complete true still works from a sender with no chat', async () => {
		const f = await seed()
		const helper = await spawnHelper(f, f.cronSession.id, { notify_on_complete: true })
		expect(helper.notify).toBe(true)
	})

	it('a sender with no chat of its own (cron, header-less, helper) keeps today’s default', async () => {
		const f = await seed()
		expect((await spawnHelper(f, f.cronSession.id)).notify).toBeUndefined()
		expect((await spawnHelper(f, null)).notify).toBeUndefined()
		// A helper carries the chat only as a stamp, not as its own conversation.
		expect((await spawnHelper(f, f.helperSession.id)).notify).toBeUndefined()
	})

	it('a group chat gets no default', async () => {
		const f = await seed()
		const second = await insertActor(db, { type: 'human', name: 'Second Person' })
		await db
			.insert(conversationParticipants)
			.values({ conversationId: f.chat.id, actorId: second.id, addedBy: f.human.id })
		expect((await spawnHelper(f, f.chatSession.id)).notify).toBeUndefined()
	})
})

describe('origin stamp on sessions woken by an @mention', () => {
	it('an agent woken by an @mention from a chat session carries the chat', async () => {
		const f = await seed()
		const { id } = await postComment(f, { session: f.chatSession.id, mentions: [f.other.id] })
		await dispatch(f, id)
		const woken = created.find((c) => c.actorId === f.other.id)
		expect(woken?.config.origin_conversation_id).toBe(f.chat.id)
	})

	it('an agent woken by an @mention from a cron session carries none', async () => {
		const f = await seed()
		const { id } = await postComment(f, { session: f.cronSession.id, mentions: [f.other.id] })
		await dispatch(f, id)
		const woken = created.find((c) => c.actorId === f.other.id)
		expect(woken).toBeDefined()
		expect(woken?.config.origin_conversation_id).toBeUndefined()
	})
})

describe('planCommentRouting: each rule flips the result on its own', () => {
	const base = (f: Fixture, over: Partial<Parameters<typeof planCommentRouting>[1]> = {}) => ({
		workspaceId: f.ws.id,
		commenterId: f.agent.id,
		commenterType: 'agent',
		sessionId: f.helperSession.id as string | undefined,
		mentions: [f.human.id] as string[] | undefined,
		hasDecision: false,
		attention: undefined as number | undefined,
		...over,
	})

	it('routes when all six rules hold, and drops only that human from the mentions', async () => {
		const f = await seed()
		const plan = await planCommentRouting(db, base(f, { mentions: [f.human.id, f.other.id] }))
		expect(plan.delivery).toEqual({
			humanId: f.human.id,
			conversationId: f.chat.id,
			ownChat: false,
		})
		expect(plan.storedMentions).toEqual([f.other.id])
		expect(plan.routedTo).toBe('chat')
		expect(plan.routeReason).toBe('routed')
	})

	const keeps: Array<{
		name: string
		reason: string
		over: (f: KeepCtx) => Partial<Parameters<typeof planCommentRouting>[1]>
		prep?: (f: Fixture) => Promise<void>
	}> = [
		{
			name: 'rule 2: a decision block',
			reason: 'kept_decision',
			over: () => ({ hasDecision: true }),
		},
		{
			name: 'rule 3: attention 4',
			reason: 'kept_attention',
			over: () => ({ attention: 4 }),
		},
		{
			name: 'rule 3: attention 5',
			reason: 'kept_attention',
			over: () => ({ attention: 5 }),
		},
		{
			name: 'rule 4: no header',
			reason: 'no_origin',
			over: () => ({ sessionId: undefined }),
		},
		{
			name: 'rule 4: header names another actor session',
			reason: 'no_origin',
			over: (f) => ({ sessionId: f.otherSessionId }),
		},
		{
			name: 'rule 4: header names a session in another workspace',
			reason: 'no_origin',
			over: (f) => ({ sessionId: f.elsewhereSessionId }),
		},
		{
			name: 'rule 5: the session has no chat origin (cron)',
			reason: 'no_origin',
			over: (f) => ({ sessionId: f.cronSession.id }),
		},
		{
			name: 'rule 5: the origin chat is in another workspace',
			reason: 'no_origin',
			over: (f) => ({ sessionId: f.foreignChatSessionId }),
		},
		{
			name: 'rule 6: a second human is in the chat',
			reason: 'kept_group',
			prep: async (f) => {
				const second = await insertActor(db, { type: 'human', name: 'Second Person' })
				await db
					.insert(conversationParticipants)
					.values({ conversationId: f.chat.id, actorId: second.id, addedBy: f.human.id })
			},
			over: () => ({}),
		},
		{
			name: 'rule 6: a second agent is in the chat',
			reason: 'kept_group',
			prep: async (f) => {
				await db
					.insert(conversationParticipants)
					.values({ conversationId: f.chat.id, actorId: f.other.id, addedBy: f.human.id })
			},
			over: () => ({}),
		},
		{
			name: 'rule 6: the human is not in the chat',
			reason: 'kept_group',
			prep: async (f) => {
				await db
					.update(conversationParticipants)
					.set({ leftAt: new Date() })
					.where(
						and(
							eq(conversationParticipants.conversationId, f.chat.id),
							eq(conversationParticipants.actorId, f.human.id),
						),
					)
			},
			over: () => ({}),
		},
	]

	it.each(keeps)('keeps the mention: $name', async ({ reason, over, prep }) => {
		const f = await seed()
		const otherSession = await insertSession(db, f.ws.id, f.other.id, f.other.id, {
			status: 'running',
			config: { origin_conversation_id: f.chat.id },
		})
		const otherWs = await insertWorkspace(db, f.human.id)
		const elsewhere = await insertSession(db, otherWs.id, f.agent.id, f.agent.id, {
			status: 'running',
			config: { origin_conversation_id: f.chat.id },
		})
		const foreignChat = await insertConversation(db, otherWs.id, f.human.id)
		await db.insert(conversationParticipants).values([
			{ conversationId: foreignChat.id, actorId: f.human.id, addedBy: f.human.id },
			{ conversationId: foreignChat.id, actorId: f.agent.id, addedBy: f.human.id },
		])
		const foreignChatSession = await insertSession(db, f.ws.id, f.agent.id, f.agent.id, {
			status: 'running',
			config: { origin_conversation_id: foreignChat.id },
		})
		const fx: KeepCtx = {
			...f,
			otherSessionId: otherSession.id,
			elsewhereSessionId: elsewhere.id,
			foreignChatSessionId: foreignChatSession.id,
		}
		await prep?.(f)

		const plan = await planCommentRouting(db, base(f, over(fx)))

		expect(plan.delivery).toBeNull()
		expect(plan.storedMentions).toEqual([f.human.id])
		expect(plan.routedTo).toBe('for_you')
		expect(plan.routeReason).toBe(reason)
	})

	it('attention 3 routes and a missing attention routes', async () => {
		const f = await seed()
		expect((await planCommentRouting(db, base(f, { attention: 3 }))).delivery).not.toBeNull()
		expect(
			(await planCommentRouting(db, base(f, { attention: undefined }))).delivery,
		).not.toBeNull()
	})

	it('a human commenter is never routed', async () => {
		const f = await seed()
		const plan = await planCommentRouting(db, base(f, { commenterType: 'human' }))
		expect(plan.delivery).toBeNull()
		expect(plan.storedMentions).toEqual([f.human.id])
	})

	it('two humans mentioned, one in the origin chat: only that one is routed', async () => {
		const f = await seed()
		const stranger = await insertActor(db, { type: 'human', name: 'Stranger' })
		const plan = await planCommentRouting(db, base(f, { mentions: [stranger.id, f.human.id] }))
		expect(plan.delivery?.humanId).toBe(f.human.id)
		expect(plan.storedMentions).toEqual([stranger.id])
		expect(plan.routedTo).toBe('for_you')
	})

	it('a helper that carries only ask_conversation_id still routes to its chat', async () => {
		const f = await seed()
		const plan = await planCommentRouting(db, base(f, { sessionId: f.askOnlySession.id }))
		expect(plan.delivery?.conversationId).toBe(f.chat.id)
		expect(plan.sessionOrigin).toBe('chat_helper')
	})

	it('a participant who left the chat does not turn a 1-1 into a group', async () => {
		const f = await seed()
		const gone = await insertActor(db, { type: 'human', name: 'Gone' })
		await db.insert(conversationParticipants).values({
			conversationId: f.chat.id,
			actorId: gone.id,
			addedBy: f.human.id,
			leftAt: new Date(),
		})
		expect((await planCommentRouting(db, base(f))).delivery).not.toBeNull()
	})
})

describe('POST /api/events from a chat-started helper', () => {
	it('leaves no For You item, one chat message with the pill, unread 1, and no needs_input row', async () => {
		const f = await seed()

		const { id, data } = await postComment(f, {
			session: f.helperSession.id,
			mentions: [f.human.id, f.other.id],
		})
		await dispatch(f, id)

		// The object comment is the audit record: it exists, minus the routed human.
		expect(data.mentions).toEqual([f.other.id])
		expect(await forYouEntityIds(f)).not.toContain(f.object.id)
		expect(await needsInputFor(f.human.id)).toHaveLength(0)

		const inChat = await chatMessages(f.chat.id)
		expect(inChat).toHaveLength(1)
		expect(inChat[0]?.actorId).toBe(f.agent.id)
		expect(inChat[0]?.content).toBe('Backfill finished, 12 rows updated.')
		expect(inChat[0]?.metadata).toMatchObject({
			delivery: { kind: 'routed_comment', object_id: f.object.id, comment_event_id: id },
			context_objects: [{ id: f.object.id, title: 'Backfill report', type: 'task' }],
		})
		expect(await chatUnreadCount(f)).toBe(1)
	})

	it('starts no session', async () => {
		const f = await seed()
		const before = (await db.select().from(sessions)).length
		await postComment(f, { session: f.helperSession.id })
		expect((await db.select().from(sessions)).length).toBe(before)
	})

	it('cuts a long comment and ends the chat message with a link to the rest', async () => {
		const f = await seed()
		const paragraphs = Array.from({ length: 6 }, (_, i) => `Part ${i} ${'y'.repeat(500)}`)
		await postComment(f, { session: f.helperSession.id, content: paragraphs.join('\n\n') })
		const [msg] = await chatMessages(f.chat.id)
		expect(msg?.content).toContain('Read the rest: [Backfill report](')
		expect(msg?.content).toContain(`/${f.ws.id}/objects/${f.object.id})`)
		expect(msg?.content.length).toBeLessThan(1500 + 300)
	})

	it('posts a one-line pointer when the commenting session is the chat session', async () => {
		const f = await seed()
		await postComment(f, { session: f.chatSession.id, content: 'Long update. '.repeat(50) })
		const [msg] = await chatMessages(f.chat.id)
		expect(msg?.content).toMatch(/^I posted an update on \[Backfill report\]\(.+\)\.$/)
	})

	it('keeps the For You card and the notification for a decision block (zero-miss guard)', async () => {
		const f = await seed()

		const { id, data } = await postComment(f, {
			session: f.helperSession.id,
			decision: DECISION,
		})
		await dispatch(f, id)

		expect(data.mentions).toEqual([f.human.id])
		expect(await forYouEntityIds(f)).toContain(f.object.id)
		expect(await needsInputFor(f.human.id)).toHaveLength(1)
		expect(await chatMessages(f.chat.id)).toHaveLength(0)

		// The validator's query: a decision that did not reach For You.
		const props = lastCommentProps()
		expect(props.has_decision_block).toBe(true)
		expect(props.routed_to).toBe('for_you')
	})

	it('keeps the For You card for attention 4', async () => {
		const f = await seed()
		const { data } = await postComment(f, { session: f.helperSession.id, attention: 4 })
		expect(data.mentions).toEqual([f.human.id])
		expect(await forYouEntityIds(f)).toContain(f.object.id)
		expect(lastCommentProps().routed_to).toBe('for_you')
	})

	it('keeps the card for the same helper started by cron', async () => {
		const f = await seed()
		const { data } = await postComment(f, { session: f.cronSession.id })
		expect(data.mentions).toEqual([f.human.id])
		expect(await forYouEntityIds(f)).toContain(f.object.id)
		expect(await chatMessages(f.chat.id)).toHaveLength(0)
	})

	it('a header naming another agent session cannot route a comment', async () => {
		const f = await seed()
		const theirs = await insertSession(db, f.ws.id, f.other.id, f.other.id, {
			status: 'running',
			config: { origin_conversation_id: f.chat.id },
		})
		const { data } = await postComment(f, { session: theirs.id })
		expect(data.mentions).toEqual([f.human.id])
		expect(await chatMessages(f.chat.id)).toHaveLength(0)
	})
})

function lastCommentProps() {
	const calls = capturePosthogEvent.mock.calls.filter((c) => c[0] === 'agent_comment_posted')
	return (calls[calls.length - 1]?.[2] ?? {}) as Record<string, unknown>
}

describe('agent_comment_posted: session_origin, has_decision_block, routed_to', () => {
	type Case = {
		name: string
		pick: (f: Fixture) => PostOver
		on: [string, boolean, string]
	}
	const cases: Case[] = [
		{
			name: 'chat session, plain comment',
			pick: (f) => ({ session: f.chatSession.id }),
			on: ['chat', false, 'chat'],
		},
		{
			name: 'chat session, decision block',
			pick: (f) => ({ session: f.chatSession.id, decision: DECISION }),
			on: ['chat', true, 'for_you'],
		},
		{
			name: 'chat-spawned helper, plain comment',
			pick: (f) => ({ session: f.helperSession.id }),
			on: ['chat_helper', false, 'chat'],
		},
		{
			name: 'cron session',
			pick: (f) => ({ session: f.cronSession.id }),
			on: ['none', false, 'for_you'],
		},
		{
			name: 'no header',
			pick: () => ({ session: null }),
			on: ['no_session', false, 'for_you'],
		},
		{
			name: 'no human mention',
			pick: (f) => ({ session: f.chatSession.id, mentions: [f.other.id] }),
			on: ['chat', false, 'none'],
		},
	]

	it.each(cases)('$name', async (c) => {
		const f = await seed()
		await postComment(f, c.pick(f))
		await vi.waitFor(() => expect(lastCommentProps().session_origin).toBeDefined())
		const [origin, decision, routedTo] = c.on
		expect(lastCommentProps()).toMatchObject({
			session_origin: origin,
			has_decision_block: decision,
			routed_to: routedTo,
		})
	})

	it('carries a reason for the split', async () => {
		const f = await seed()
		await postComment(f, { session: f.helperSession.id })
		await vi.waitFor(() => expect(lastCommentProps().route_reason).toBe('routed'))
	})
})
