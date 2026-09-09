import { events, workspaceMembers } from '@maskin/db/schema'
import { PgNotifyBridge } from '@maskin/realtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionManager } from '../../services/session-manager'
import { CommentDispatcher } from '../../services/trigger-runner'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Closes the gap named in PR #1579's review ("What I couldn't verify"): every
// existing test hand-emits a `PgEvent` object into a bare `EventEmitter`, so
// the segment between an `events` INSERT and the dispatcher was never
// exercised. Here the ONLY thing that moves the event is Postgres itself — the
// `events` NOTIFY trigger fires on INSERT, a real `PgNotifyBridge` LISTENs on
// the real database, and `CommentDispatcher` is subscribed to that bridge
// exactly as `apps/dev/src/index.ts` wires it. Nothing calls `emit()`.
//
// Still stubbed: `SessionManager`, so no container is spawned. The seam this
// covers is bridge → dispatcher → session-manager call, which is precisely the
// "silently broken between bridge and session-manager" failure the review
// flagged as only detectable in the 14-day watch window.

const capturePosthogEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: (...args: unknown[]) => capturePosthogEvent(...args),
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

type MockSessionManager = ReturnType<typeof createMockSessionManager>

function collectDispatchCalls(sm: MockSessionManager) {
	return [
		...(sm.enqueueSession.mock.calls as unknown[][]),
		...(sm.createSession.mock.calls as unknown[][]),
	]
}

function dispatchPayload(call: unknown[]) {
	const [firstArg, secondArg] = call
	return (secondArg ?? firstArg) as Record<string, unknown> & {
		config?: Record<string, unknown>
	}
}

describe('Comment dispatch over a real PG NOTIFY bridge (end-to-end transport)', () => {
	let bridge: PgNotifyBridge
	let sessionManager: MockSessionManager
	let dispatcher: CommentDispatcher

	beforeEach(async () => {
		capturePosthogEvent.mockClear()
		const url = process.env.DATABASE_URL
		if (!url) throw new Error('DATABASE_URL required for integration tests')
		bridge = new PgNotifyBridge(url)
		// Must actually LISTEN — a constructed-but-unstarted bridge delivers
		// nothing, which makes the negative-control test below pass for the
		// wrong reason and every positive assertion time out.
		await bridge.start()
		sessionManager = createMockSessionManager()
		dispatcher = new CommentDispatcher(db, bridge, sessionManager as unknown as SessionManager)
		dispatcher.start()
	})

	afterEach(async () => {
		dispatcher.stop()
		await bridge.stop()
		vi.restoreAllMocks()
	})

	it('carries a commented event from INSERT through the trigger to a case-2 driver dispatch', async () => {
		const humanActor = getTestActorId()
		const driverAgent = await insertActor(db, {
			type: 'agent',
			name: 'Strategist',
			email: 'strategist-notify@integration.test',
			apiKey: 'ank_strategist_notify',
		})
		const ws = await insertWorkspace(db, humanActor)
		const object = await insertObject(db, ws.id, humanActor, {
			type: 'bet',
			title: 'Does the NOTIFY path actually reach the dispatcher?',
			driver: driverAgent.id,
		})

		// The only trigger in this test: a plain INSERT. The DB trigger builds
		// the payload and NOTIFYs; the bridge is already LISTENing.
		const [row] = await db
			.insert(events)
			.values({
				workspaceId: ws.id,
				actorId: humanActor,
				action: 'commented',
				entityType: 'object',
				entityId: object.id,
				data: { content: 'Answering your question — yes, ship it.', mentions: [] },
			})
			.returning({ id: events.id })

		await vi.waitFor(() => expect(collectDispatchCalls(sessionManager).length).toBeGreaterThan(0), {
			timeout: 10_000,
			interval: 25,
		})

		const dispatches = collectDispatchCalls(sessionManager)
		expect(dispatches).toHaveLength(1)
		const payload = dispatchPayload(dispatches[0])
		expect(payload.actorId).toBe(driverAgent.id)
		expect(payload.triggerSource ?? payload.config?.triggerSource).toBe('comment_fallback')
		expect(String(payload.sourceCommentEventId ?? payload.config?.sourceCommentEventId)).toBe(
			String(row.id),
		)

		const resolved = capturePosthogEvent.mock.calls.filter(
			(c: unknown[]) => c[0] === 'comment_responder_resolved',
		)
		expect(resolved).toHaveLength(1)
		expect(resolved[0][2]).toMatchObject({
			case: 'case_2_driver_fallback',
			resolved_actor_id: driverAgent.id,
		})
	})

	it('falls through to a case-3 Chief of Staff dispatch when the object has no driver', async () => {
		const humanActor = getTestActorId()
		const ws = await insertWorkspace(db, humanActor)
		// The workspace's own Chief of Staff — resolved by name through
		// `workspace_members`, exactly as every workspace seeds it at creation.
		// There is no global CoS actor id to fall back on.
		const cos = await insertActor(db, {
			type: 'agent',
			name: 'Chief of Staff',
			email: 'cos-notify@integration.test',
			apiKey: 'ank_cos_notify',
		})
		await db.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: cos.id,
			role: 'member',
		})
		const object = await insertObject(db, ws.id, humanActor, {
			type: 'bet',
			title: 'Driverless object over the real bridge',
		})

		await db.insert(events).values({
			workspaceId: ws.id,
			actorId: humanActor,
			action: 'commented',
			entityType: 'object',
			entityId: object.id,
			data: { content: 'Who owns this?', mentions: [] },
		})

		await vi.waitFor(() => expect(collectDispatchCalls(sessionManager).length).toBeGreaterThan(0), {
			timeout: 10_000,
			interval: 25,
		})

		const payload = dispatchPayload(collectDispatchCalls(sessionManager)[0])
		expect(payload.actorId).toBe(cos.id)

		const resolved = capturePosthogEvent.mock.calls.filter(
			(c: unknown[]) => c[0] === 'comment_responder_resolved',
		)
		expect(resolved).toHaveLength(1)
		expect(resolved[0][2]).toMatchObject({ case: 'case_3_cos_fallback', resolved_actor_id: cos.id })
	})

	it('ignores a non-comment event that travels the same NOTIFY channel', async () => {
		const humanActor = getTestActorId()
		const ws = await insertWorkspace(db, humanActor)
		const object = await insertObject(db, ws.id, humanActor, { type: 'bet' })

		await db.insert(events).values({
			workspaceId: ws.id,
			actorId: humanActor,
			action: 'updated',
			entityType: 'object',
			entityId: object.id,
			data: { title: 'renamed' },
		})

		// Give the bridge a real window to deliver before asserting silence.
		await new Promise((r) => setTimeout(r, 1_500))
		expect(collectDispatchCalls(sessionManager)).toHaveLength(0)
	})
})
