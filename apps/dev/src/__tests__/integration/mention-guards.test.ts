import { EventEmitter } from 'node:events'
import { events, sessions } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MENTION_GUARD_LIMITS, normalizeMentionText } from '../../services/mention-guards'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { CommentDispatcher } from '../../services/trigger-runner'
import { insertActor, insertObject, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Loop guards on agent-authored @mentions, against real Postgres: the cap counts
// the sessions table (jsonb path + join on actors) and the duplicate check reads
// the author's recent comment events, so a mocked db would not exercise either.

const capturePosthogEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: (...args: unknown[]) => capturePosthogEvent(...args),
}))

type StartedSession = { actorId: string; objectId: string | null }

/**
 * A session manager whose createSession writes a real sessions row the way the
 * production one does (trigger_source stamped into config), so the cap can count it.
 */
function createRecordingSessionManager(started: StartedSession[]) {
	return {
		enqueueSession: vi.fn(),
		createSession: vi.fn(async (workspaceId: string, params: Record<string, unknown>) => {
			const config = { ...((params.config as object) ?? {}) } as Record<string, unknown>
			if (params.triggerSource) config.trigger_source = params.triggerSource
			const row = await insertSession(
				db,
				workspaceId,
				params.actorId as string,
				params.createdBy as string,
				{
					config,
					status: 'completed',
					spawnedBySessionId: params.spawnedBySessionId ?? null,
					initiatedFromObjectId: params.initiatedFromObjectId ?? null,
					initiatedFromObjectType: params.initiatedFromObjectType ?? null,
				},
			)
			started.push({
				actorId: params.actorId as string,
				objectId: (params.initiatedFromObjectId as string | null) ?? null,
			})
			return row
		}),
		stopSession: vi.fn(),
		pauseSession: vi.fn(),
		resumeSession: vi.fn(),
		writeInput: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
	}
}

async function comment(opts: {
	workspaceId: string
	actorId: string
	entityId: string
	content: string
	mentions: string[]
	metadata?: Record<string, unknown>
	authorSessionId?: string
}): Promise<number> {
	const rows = await db
		.insert(events)
		.values({
			workspaceId: opts.workspaceId,
			actorId: opts.actorId,
			action: 'commented',
			entityType: 'object',
			entityId: opts.entityId,
			data: {
				content: opts.content,
				mentions: opts.mentions,
				...(opts.metadata ? { metadata: opts.metadata } : {}),
				...(opts.authorSessionId ? { authorSessionId: opts.authorSessionId } : {}),
			},
		})
		.returning({ id: events.id })
	return rows[0].id
}

describe('Agent-mention loop guards (integration)', () => {
	let bridge: EventEmitter & PgNotifyBridge
	let started: StartedSession[]
	let dispatcher: CommentDispatcher

	beforeEach(() => {
		capturePosthogEvent.mockClear()
		started = []
		bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		const sm = createRecordingSessionManager(started)
		configureSessionLifecycle({ db, sessionManager: sm as unknown as SessionManager })
		dispatcher = new CommentDispatcher(db, bridge, sm as unknown as SessionManager)
		dispatcher.start()
	})

	afterEach(() => {
		dispatcher.stop()
		vi.restoreAllMocks()
	})

	async function world() {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const mk = (name: string) =>
			insertActor(db, {
				type: 'agent',
				name,
				email: `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}@integration.test`,
				apiKey: `ank_${name}_${Math.random().toString(36).slice(2)}`,
			})
		const [a, b, c] = await Promise.all([mk('Alpha'), mk('Bravo'), mk('Charlie')])
		const object = await insertObject(db, ws.id, human, { type: 'task', title: 'ring' })
		return { human, ws, a, b, c, object }
	}

	async function fire(
		ws: { id: string },
		actorId: string,
		entityId: string,
		eventId: number,
	): Promise<void> {
		const ev: PgEvent = {
			workspace_id: ws.id,
			actor_id: actorId,
			action: 'commented',
			entity_type: 'object',
			entity_id: entityId,
			event_id: String(eventId),
		}
		bridge.emit('event', ev)
		// handleEvent is fire-and-forget behind the bridge; wait for it to settle.
		await new Promise((r) => setTimeout(r, 250))
	}

	const guardDecisions = () =>
		capturePosthogEvent.mock.calls
			.filter((c: unknown[]) => c[0] === 'mention_guard_decision')
			.map((c: unknown[]) => c[2] as { result: string; reason: string })

	it('a ring of three agents mentioning each other stops at the cap, not unbounded', async () => {
		const { ws, a, b, c, object } = await world()
		const ring = [
			[a, b],
			[b, c],
			[c, a],
		] as const

		// Each lap is a distinct comment text so the duplicate check does not
		// stop it first; only the per-hour cap is under test here.
		for (let lap = 0; lap < 6; lap++) {
			for (const [from, to] of ring) {
				const id = await comment({
					workspaceId: ws.id,
					actorId: from.id,
					entityId: object.id,
					content: `lap ${lap} from ${from.name} to ${to.name}, please look`,
					mentions: [to.id],
				})
				await fire(ws, from.id, object.id, id)
			}
		}

		for (const target of [a, b, c]) {
			const count = started.filter((s) => s.actorId === target.id).length
			expect(count).toBe(MENTION_GUARD_LIMITS.maxAgentMentionsPerWindow)
		}
		expect(guardDecisions().filter((d) => d.reason === 'mention_capped').length).toBeGreaterThan(0)
	}, 60_000)

	it('a capped mention still leaves a pending needs_input notification', async () => {
		const { ws, a, b, object } = await world()
		for (let i = 0; i < MENTION_GUARD_LIMITS.maxAgentMentionsPerWindow + 1; i++) {
			const id = await comment({
				workspaceId: ws.id,
				actorId: a.id,
				entityId: object.id,
				content: `distinct ask number ${i}`,
				mentions: [b.id],
			})
			await fire(ws, a.id, object.id, id)
		}
		expect(started.filter((s) => s.actorId === b.id)).toHaveLength(
			MENTION_GUARD_LIMITS.maxAgentMentionsPerWindow,
		)
		const { notifications } = await import('@maskin/db/schema')
		const rows = await db
			.select({ status: notifications.status })
			.from(notifications)
			.where(eq(notifications.targetActorId, b.id))
		expect(rows).toHaveLength(MENTION_GUARD_LIMITS.maxAgentMentionsPerWindow + 1)
		expect(rows.every((r) => r.status === 'pending')).toBe(true)
	}, 60_000)

	it('the same mention twice from the same author starts one session', async () => {
		const { ws, a, b, object } = await world()
		const first = await comment({
			workspaceId: ws.id,
			actorId: a.id,
			entityId: object.id,
			content: '@Bravo please review the migration',
			mentions: [b.id],
		})
		await fire(ws, a.id, object.id, first)
		const second = await comment({
			workspaceId: ws.id,
			actorId: a.id,
			entityId: object.id,
			content: '  @Bravo   Please review the MIGRATION ',
			mentions: [b.id],
		})
		await fire(ws, a.id, object.id, second)

		expect(started.filter((s) => s.actorId === b.id)).toHaveLength(1)
		expect(guardDecisions().map((d) => d.reason)).toEqual(['ok', 'mention_duplicate'])
	}, 30_000)

	it('human-authored mentions are exempt from the cap', async () => {
		const { ws, human, b, object } = await world()
		for (let i = 0; i < MENTION_GUARD_LIMITS.maxAgentMentionsPerWindow + 2; i++) {
			const id = await comment({
				workspaceId: ws.id,
				actorId: human,
				entityId: object.id,
				content: `human ask ${i}`,
				mentions: [b.id],
			})
			await fire(ws, human, object.id, id)
		}
		expect(started.filter((s) => s.actorId === b.id)).toHaveLength(
			MENTION_GUARD_LIMITS.maxAgentMentionsPerWindow + 2,
		)
		expect(guardDecisions()).toHaveLength(0)
	}, 60_000)

	it('a forged helper_return marker does not exempt a mention from the cap', async () => {
		const { ws, a, b, object } = await world()
		// An unrelated session of someone else, named in the marker, with no claim taken.
		const stranger = await insertSession(db, ws.id, b.id, a.id, { status: 'completed' })
		for (let i = 0; i < MENTION_GUARD_LIMITS.maxAgentMentionsPerWindow + 1; i++) {
			const id = await comment({
				workspaceId: ws.id,
				actorId: a.id,
				entityId: object.id,
				content: `forged ${i}`,
				mentions: [b.id],
				metadata: { helper_return: stranger.id },
			})
			await fire(ws, a.id, object.id, id)
		}
		expect(started.filter((s) => s.actorId === b.id)).toHaveLength(
			MENTION_GUARD_LIMITS.maxAgentMentionsPerWindow,
		)
	}, 60_000)

	it('a genuine return (own session, claim taken) is exempt and not counted', async () => {
		const { ws, a, b, object } = await world()
		// a is the helper, b is the sender. a's session took its return claim.
		const senderSession = await insertSession(db, ws.id, b.id, b.id, { status: 'completed' })
		const helperSession = await insertSession(db, ws.id, a.id, b.id, {
			status: 'completed',
			helperReturnedAt: new Date(),
			spawnedBySessionId: senderSession.id,
			initiatedFromObjectId: object.id,
		})
		const id = await comment({
			workspaceId: ws.id,
			actorId: a.id,
			entityId: object.id,
			content: 'Alpha finished the work you handed it.',
			mentions: [b.id],
			metadata: { helper_return: helperSession.id },
		})
		await fire(ws, a.id, object.id, id)
		expect(started.filter((s) => s.actorId === b.id)).toHaveLength(1)
		const [row] = await db
			.select({ config: sessions.config })
			.from(sessions)
			.where(eq(sessions.actorId, b.id))
		expect((row.config as { mention?: { helper_return?: boolean } }).mention?.helper_return).toBe(
			true,
		)
		// A return does not count toward the 3 per hour: three ordinary mentions still fit.
		for (let i = 0; i < MENTION_GUARD_LIMITS.maxAgentMentionsPerWindow; i++) {
			const cid = await comment({
				workspaceId: ws.id,
				actorId: a.id,
				entityId: object.id,
				content: `ordinary ${i}`,
				mentions: [b.id],
			})
			await fire(ws, a.id, object.id, cid)
		}
		expect(started.filter((s) => s.actorId === b.id)).toHaveLength(
			1 + MENTION_GUARD_LIMITS.maxAgentMentionsPerWindow,
		)
	}, 60_000)
})

describe('Reused helper_return marker (integration)', () => {
	let bridge: EventEmitter & PgNotifyBridge
	let started: StartedSession[]
	let dispatcher: CommentDispatcher

	beforeEach(() => {
		capturePosthogEvent.mockClear()
		started = []
		bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		const sm = createRecordingSessionManager(started)
		configureSessionLifecycle({ db, sessionManager: sm as unknown as SessionManager })
		dispatcher = new CommentDispatcher(db, bridge, sm as unknown as SessionManager)
		dispatcher.start()
	})

	afterEach(() => {
		dispatcher.stop()
		vi.restoreAllMocks()
	})

	// helper has returned to sender on object; stranger is neither.
	async function world() {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const mk = (name: string) =>
			insertActor(db, {
				type: 'agent',
				name,
				email: `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}@integration.test`,
				apiKey: `ank_${name}_${Math.random().toString(36).slice(2)}`,
			})
		const [helper, sender, stranger] = await Promise.all([
			mk('Helper'),
			mk('Sender'),
			mk('Stranger'),
		])
		const object = await insertObject(db, ws.id, human, { type: 'task', title: 'return' })
		const elsewhere = await insertObject(db, ws.id, human, { type: 'task', title: 'elsewhere' })
		const senderSession = await insertSession(db, ws.id, sender.id, sender.id, {
			status: 'completed',
		})
		const helperSession = await insertSession(db, ws.id, helper.id, sender.id, {
			status: 'completed',
			helperReturnedAt: new Date(),
			spawnedBySessionId: senderSession.id,
			initiatedFromObjectId: object.id,
		})
		return { ws, helper, sender, stranger, object, elsewhere, helperSession }
	}

	async function post(
		ws: { id: string },
		from: { id: string },
		to: { id: string },
		objectId: string,
		marker: string,
		content: string,
	) {
		const id = await comment({
			workspaceId: ws.id,
			actorId: from.id,
			entityId: objectId,
			content,
			mentions: [to.id],
			metadata: { helper_return: marker },
		})
		bridge.emit('event', {
			workspace_id: ws.id,
			actor_id: from.id,
			action: 'commented',
			entity_type: 'object',
			entity_id: objectId,
			event_id: String(id),
		} satisfies PgEvent)
		await new Promise((r) => setTimeout(r, 250))
	}

	const rowsFor = (actorId: string) =>
		db.select().from(sessions).where(eq(sessions.actorId, actorId))
	const isReturn = (row: { config: unknown }) =>
		(row.config as { mention?: { helper_return?: boolean } }).mention?.helper_return === true

	it('works once: a reused marker is an ordinary mention, so the cap applies', async () => {
		const { ws, helper, sender, object, helperSession } = await world()
		// The reviewer's repro: six comments, all naming the same returned session.
		for (let i = 0; i < 6; i++) {
			await post(ws, helper, sender, object.id, helperSession.id, `reuse ${i}, please look`)
		}
		const rows = await rowsFor(sender.id)
		expect(rows.filter(isReturn)).toHaveLength(1)
		expect(rows).toHaveLength(1 + MENTION_GUARD_LIMITS.maxAgentMentionsPerWindow)
	}, 60_000)

	it('the marker only counts for the sender of the helper session', async () => {
		const { ws, helper, stranger, object, helperSession } = await world()
		await post(ws, helper, stranger, object.id, helperSession.id, 'wake someone else')
		const rows = await rowsFor(stranger.id)
		expect(rows).toHaveLength(1)
		expect(rows.some(isReturn)).toBe(false)
	})

	it('the marker only counts on the object the return is posted to', async () => {
		const { ws, helper, sender, elsewhere, helperSession } = await world()
		await post(ws, helper, sender, elsewhere.id, helperSession.id, 'wrong thread')
		const rows = await rowsFor(sender.id)
		expect(rows).toHaveLength(1)
		expect(rows.some(isReturn)).toBe(false)
	})

	it('a failed forged attempt elsewhere does not use up the real return', async () => {
		const { ws, helper, sender, stranger, object, elsewhere, helperSession } = await world()
		await post(ws, helper, stranger, object.id, helperSession.id, 'forged target')
		await post(ws, helper, sender, elsewhere.id, helperSession.id, 'forged object')
		await post(ws, helper, sender, object.id, helperSession.id, 'the real return')
		expect((await rowsFor(sender.id)).filter(isReturn)).toHaveLength(1)
	})
})

describe('Mention spawn link (integration)', () => {
	let bridge: EventEmitter & PgNotifyBridge
	let started: StartedSession[]
	let dispatcher: CommentDispatcher

	beforeEach(() => {
		capturePosthogEvent.mockClear()
		started = []
		bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		const sm = createRecordingSessionManager(started)
		configureSessionLifecycle({ db, sessionManager: sm as unknown as SessionManager })
		dispatcher = new CommentDispatcher(db, bridge, sm as unknown as SessionManager)
		dispatcher.start()
	})

	afterEach(() => {
		dispatcher.stop()
		vi.restoreAllMocks()
	})

	async function setup() {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const mk = (name: string) =>
			insertActor(db, {
				type: 'agent',
				name,
				email: `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}@integration.test`,
				apiKey: `ank_${name}_${Math.random().toString(36).slice(2)}`,
			})
		const [author, helper, other] = await Promise.all([mk('Author'), mk('Helper'), mk('Other')])
		const object = await insertObject(db, ws.id, human, { type: 'task', title: 'link' })
		return { ws, author, helper, other, object }
	}

	async function mention(
		ws: { id: string },
		from: { id: string },
		to: { id: string },
		objectId: string,
		extra: { authorSessionId?: string; metadata?: Record<string, unknown>; content?: string },
	) {
		const id = await comment({
			workspaceId: ws.id,
			actorId: from.id,
			entityId: objectId,
			content: extra.content ?? 'please take this',
			mentions: [to.id],
			authorSessionId: extra.authorSessionId,
			metadata: extra.metadata,
		})
		bridge.emit('event', {
			workspace_id: ws.id,
			actor_id: from.id,
			action: 'commented',
			entity_type: 'object',
			entity_id: objectId,
			event_id: String(id),
		} satisfies PgEvent)
		await new Promise((r) => setTimeout(r, 250))
	}

	const startedRows = (actorId: string) =>
		db.select().from(sessions).where(eq(sessions.actorId, actorId))

	it('links the mentioned agent’s session to the author’s own live session, depth 1', async () => {
		const { ws, author, helper, object } = await setup()
		const mine = await insertSession(db, ws.id, author.id, author.id, { status: 'running' })
		await mention(ws, author, helper, object.id, { authorSessionId: mine.id })
		const [row] = await startedRows(helper.id)
		expect(row.spawnedBySessionId).toBe(mine.id)
		expect((row.config as { hop_depth?: number }).hop_depth).toBe(1)
	})

	it('forged authorSessionId (another actor’s live session) leaves the link null', async () => {
		const { ws, author, helper, other, object } = await setup()
		const theirs = await insertSession(db, ws.id, other.id, other.id, { status: 'running' })
		await mention(ws, author, helper, object.id, { authorSessionId: theirs.id })
		const [row] = await startedRows(helper.id)
		expect(row).toBeDefined()
		expect(row.spawnedBySessionId).toBeNull()
	})

	it('a terminal author session leaves the link null', async () => {
		const { ws, author, helper, object } = await setup()
		const done = await insertSession(db, ws.id, author.id, author.id, { status: 'completed' })
		await mention(ws, author, helper, object.id, { authorSessionId: done.id })
		const [row] = await startedRows(helper.id)
		expect(row.spawnedBySessionId).toBeNull()
	})

	it('a comment from a client cannot plant an author session id through metadata', async () => {
		const { ws, author, helper, object } = await setup()
		const mine = await insertSession(db, ws.id, author.id, author.id, { status: 'running' })
		await mention(ws, author, helper, object.id, {
			metadata: { authorSessionId: mine.id },
		})
		const [row] = await startedRows(helper.id)
		expect(row.spawnedBySessionId).toBeNull()
	})

	it('a genuine return wakes the sender with no link, inheriting the helper’s depth', async () => {
		const { ws, author: sender, helper, object } = await setup()
		const senderSession = await insertSession(db, ws.id, sender.id, sender.id, {
			status: 'completed',
		})
		const helperSession = await insertSession(db, ws.id, helper.id, sender.id, {
			status: 'completed',
			helperReturnedAt: new Date(),
			config: { hop_depth: 2 },
			spawnedBySessionId: senderSession.id,
			initiatedFromObjectId: object.id,
		})
		// The return is posted as the helper, mentions the sender and, as required,
		// carries no author session id.
		await mention(ws, helper, sender, object.id, {
			metadata: { helper_return: helperSession.id },
			content: 'Helper finished the work you handed it.',
		})
		const [woken] = await startedRows(sender.id)
		expect(woken.spawnedBySessionId).toBeNull()
		expect((woken.config as { hop_depth?: number }).hop_depth).toBe(2)
		expect((woken.config as { mention?: { helper_return?: boolean } }).mention?.helper_return).toBe(
			true,
		)
	})
})

describe('normalizeMentionText', () => {
	it('lowercases, drops mention tokens and collapses whitespace', () => {
		expect(normalizeMentionText('  @Bravo   Please\nreview  THIS ')).toBe('please review this')
	})
})
