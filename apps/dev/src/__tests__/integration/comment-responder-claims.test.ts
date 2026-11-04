import { EventEmitter } from 'node:events'
import { events, commentResponderClaims } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	claimCommentResponder,
	releaseCommentResponderClaim,
} from '../../lib/comment-responder-claims'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { CommentDispatcher } from '../../services/trigger-runner'
import { ensureWorkspaceMember, insertActor, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// One responder session per (comment event, actor). The thread-reply auto-spawn
// (routes/events.ts) and the CommentDispatcher fallback ladder both started a session for the
// Chief of Staff on one comment, ~50ms apart. The dedupe is a primary key on
// comment_responder_claims, so these run against real Postgres: a mocked DB cannot show which of
// two concurrent INSERTs wins.

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

function createMockSessionManager() {
	return {
		enqueueSession: vi.fn().mockResolvedValue({ id: 'session-stub' }),
		createSession: vi.fn().mockResolvedValue({ id: 'session-stub' }),
		stopSession: vi.fn(),
		pauseSession: vi.fn(),
		resumeSession: vi.fn(),
		writeInput: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
	}
}

async function insertCommentEvent(workspaceId: string, actorId: string, entityId: string) {
	const rows = await db
		.insert(events)
		.values({
			workspaceId,
			actorId,
			action: 'commented',
			entityType: 'object',
			entityId,
			data: { content: 'Edit first', mentions: [] },
		})
		.returning({ id: events.id })
	return rows[0].id
}

async function seed() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const cos = await insertActor(db, {
		type: 'agent',
		name: 'Chief of Staff',
		email: `cos-${crypto.randomUUID()}@integration.test`,
		apiKey: `ank_cos_${crypto.randomUUID()}`,
	})
	await ensureWorkspaceMember(db, ws.id, cos.id)
	// No driver: the ladder reaches case 3 (Chief of Staff), the shape from the incident.
	const object = await insertObject(db, ws.id, human, { type: 'bet', title: 'A draft' })
	return { human, ws, cos, object }
}

describe('claimCommentResponder (integration)', () => {
	it('lets exactly one of two concurrent claims win', async () => {
		const { human, ws, cos, object } = await seed()
		const eventId = await insertCommentEvent(ws.id, human, object.id)

		const results = await Promise.all([
			claimCommentResponder(db, {
				sourceCommentEventId: eventId,
				actorId: cos.id,
				claimedBy: 'thread_reply',
			}),
			claimCommentResponder(db, {
				sourceCommentEventId: eventId,
				actorId: cos.id,
				claimedBy: 'comment_fallback',
			}),
		])

		expect(results.filter(Boolean)).toHaveLength(1)
		const rows = await db
			.select()
			.from(commentResponderClaims)
			.where(eq(commentResponderClaims.sourceCommentEventId, eventId))
		expect(rows).toHaveLength(1)
	})

	it('still lets exactly one win under heavier contention', async () => {
		const { human, ws, cos, object } = await seed()
		const eventId = await insertCommentEvent(ws.id, human, object.id)

		const results = await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				claimCommentResponder(db, {
					sourceCommentEventId: eventId,
					actorId: cos.id,
					claimedBy: i % 2 ? 'thread_reply' : 'comment_fallback',
				}),
			),
		)

		expect(results.filter(Boolean)).toHaveLength(1)
	})

	it('does not suppress a different comment event or a different actor', async () => {
		const { human, ws, cos, object } = await seed()
		const other = await insertActor(db, {
			type: 'agent',
			name: 'Strategist',
			email: `s-${crypto.randomUUID()}@integration.test`,
			apiKey: `ank_s_${crypto.randomUUID()}`,
		})
		const first = await insertCommentEvent(ws.id, human, object.id)
		const second = await insertCommentEvent(ws.id, human, object.id)

		const claim = (sourceCommentEventId: number, actorId: string) =>
			claimCommentResponder(db, { sourceCommentEventId, actorId, claimedBy: 'thread_reply' })

		expect(await claim(first, cos.id)).toBe(true)
		expect(await claim(first, other.id)).toBe(true)
		expect(await claim(second, cos.id)).toBe(true)
		expect(await claim(first, cos.id)).toBe(false)
	})

	it('lets a later caller claim again once the claim is released', async () => {
		const { human, ws, cos, object } = await seed()
		const eventId = await insertCommentEvent(ws.id, human, object.id)
		const args = { sourceCommentEventId: eventId, actorId: cos.id }

		expect(await claimCommentResponder(db, { ...args, claimedBy: 'thread_reply' })).toBe(true)
		await releaseCommentResponderClaim(db, args)
		expect(await claimCommentResponder(db, { ...args, claimedBy: 'comment_fallback' })).toBe(true)
	})
})

describe('CommentDispatcher fallback vs thread-reply claim (integration)', () => {
	let bridge: EventEmitter & PgNotifyBridge
	let sessionManager: ReturnType<typeof createMockSessionManager>
	let dispatcher: CommentDispatcher

	const dispatchCount = () =>
		sessionManager.enqueueSession.mock.calls.length + sessionManager.createSession.mock.calls.length

	const emit = (ws: string, actor: string, entity: string, eventId: number) =>
		bridge.emit('event', {
			workspace_id: ws,
			actor_id: actor,
			action: 'commented',
			entity_type: 'object',
			entity_id: entity,
			event_id: String(eventId),
		} satisfies PgEvent)

	beforeEach(() => {
		bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		sessionManager = createMockSessionManager()
		configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
		dispatcher = new CommentDispatcher(db, bridge, sessionManager as unknown as SessionManager)
		dispatcher.start()
	})

	afterEach(() => {
		dispatcher.stop()
		vi.restoreAllMocks()
	})

	it('stands down when the thread-reply path already holds the claim', async () => {
		const { human, ws, cos, object } = await seed()
		const eventId = await insertCommentEvent(ws.id, human, object.id)
		await claimCommentResponder(db, {
			sourceCommentEventId: eventId,
			actorId: cos.id,
			claimedBy: 'thread_reply',
		})

		emit(ws.id, human, object.id, eventId)
		// Wait for the dispatcher to finish handling; it writes nothing when it stands down, so
		// settle on a real signal (a later control comment dispatching) instead of a fixed sleep.
		const control = await insertCommentEvent(ws.id, human, object.id)
		emit(ws.id, human, object.id, control)
		await vi.waitFor(() => expect(dispatchCount()).toBe(1), { timeout: 5_000, interval: 25 })
		await new Promise((r) => setTimeout(r, 200))

		// Only the control comment (no prior claim) dispatched; the claimed one did not.
		expect(dispatchCount()).toBe(1)
		const calls = [
			...sessionManager.enqueueSession.mock.calls,
			...sessionManager.createSession.mock.calls,
		] as unknown[][]
		const payload = (calls[0][1] ?? calls[0][0]) as Record<string, unknown>
		expect(String(payload.sourceCommentEventId)).toBe(String(control))
	})

	it('falls back when no thread responder exists, and records its claim', async () => {
		const { human, ws, cos, object } = await seed()
		const eventId = await insertCommentEvent(ws.id, human, object.id)

		emit(ws.id, human, object.id, eventId)
		await vi.waitFor(() => expect(dispatchCount()).toBe(1), { timeout: 5_000, interval: 25 })

		const [claim] = await db
			.select()
			.from(commentResponderClaims)
			.where(eq(commentResponderClaims.sourceCommentEventId, eventId))
		expect(claim).toMatchObject({ actorId: cos.id, claimedBy: 'comment_fallback' })
	})

	it('yields one session in total when the thread-reply claim races the fallback', async () => {
		const { human, ws, cos, object } = await seed()
		const eventId = await insertCommentEvent(ws.id, human, object.id)

		const [threadWon] = await Promise.all([
			claimCommentResponder(db, {
				sourceCommentEventId: eventId,
				actorId: cos.id,
				claimedBy: 'thread_reply',
			}),
			Promise.resolve().then(() => emit(ws.id, human, object.id, eventId)),
		])
		await new Promise((r) => setTimeout(r, 500))

		// Exactly one responder: the thread path started it (we stand in for it here) or the
		// fallback did. Never both, never neither.
		expect((threadWon ? 1 : 0) + dispatchCount()).toBe(1)
	})

	it('gives the claim back when the session fails to start, so a retry answers exactly once', async () => {
		const { human, ws, object } = await seed()
		const eventId = await insertCommentEvent(ws.id, human, object.id)
		const claimRows = () =>
			db
				.select()
				.from(commentResponderClaims)
				.where(eq(commentResponderClaims.sourceCommentEventId, eventId))

		// Both launch methods fail until the flag flips, whichever one startSession uses.
		let sessionStartFails = true
		const launch = () =>
			sessionStartFails
				? Promise.reject(new Error('session failed to start'))
				: Promise.resolve({ id: 'session-stub' })
		sessionManager.enqueueSession.mockImplementation(launch)
		sessionManager.createSession.mockImplementation(launch)

		// First attempt: the claim is won, the session fails to start, the claim is released.
		emit(ws.id, human, object.id, eventId)
		await vi.waitFor(() => expect(dispatchCount()).toBeGreaterThanOrEqual(1), {
			timeout: 5_000,
			interval: 25,
		})
		await vi.waitFor(async () => expect(await claimRows()).toHaveLength(0), {
			timeout: 5_000,
			interval: 25,
		})
		const attemptsAfterFailure = dispatchCount()

		// Retry: the claim is free again, so this attempt starts the session and holds the claim.
		sessionStartFails = false
		emit(ws.id, human, object.id, eventId)
		await vi.waitFor(() => expect(dispatchCount()).toBe(attemptsAfterFailure + 1), {
			timeout: 5_000,
			interval: 25,
		})
		expect(await claimRows()).toHaveLength(1)

		// A further retry of the now-answered comment must not start a second session.
		emit(ws.id, human, object.id, eventId)
		await new Promise((r) => setTimeout(r, 500))
		expect(dispatchCount()).toBe(attemptsAfterFailure + 1)
		expect(await claimRows()).toHaveLength(1)
	})
})
