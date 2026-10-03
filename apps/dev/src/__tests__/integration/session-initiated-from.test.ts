import { events, objects, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { RuntimeTelemetry, type TelemetryClient } from '../../services/runtime-telemetry'
import { SessionManager } from '../../services/session-manager'
import { insertObject, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

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

/**
 * PostHog-shaped payload the class' capture receives. Keeps the stub small so
 * tests can assert exact keys and values without a full posthog-node fake.
 */
type CapturedPayload = {
	distinctId: string
	event: string
	properties?: Record<string, unknown>
	groups?: Record<string, string>
}

function stubTelemetry(): { telemetry: RuntimeTelemetry; captured: CapturedPayload[] } {
	const captured: CapturedPayload[] = []
	const client: TelemetryClient = {
		capture(payload) {
			captured.push(payload)
		},
		shutdown: async () => {},
	}
	return { telemetry: new RuntimeTelemetry({ client }), captured }
}

/**
 * §6.2 of the sessions-inspectable bet's tech spec. Verifies the two new
 * `initiated_from_object_*` columns on `sessions` plus the enrichment on
 * both the internal `session_failed` event (v1 §3.4) and the PostHog
 * `runtime_session_ended` capture payload (v2 §3.5) — the two payloads
 * that Criterion 3 measures against downstream.
 *
 * Real Postgres via `global-setup`. Docker is stubbed via a stub storage
 * provider + telemetry stub; the tests exercise `SessionManager`'s public
 * emit paths that don't require a live container.
 */
describe('SessionManager — initiated_from context (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		// enterpriseGranted short-circuits `checkPlanCap` inside createSession's
		// pre-flight so these tests can focus on the enrichment persistence,
		// not billing plumbing (same posture as session-trigger-provenance).
		const ws = await insertWorkspace(db, actorId, { enterpriseGranted: true })
		workspaceId = ws.id
	})

	it('persists both initiated_from_object columns on the sessions row', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'Some bet',
		})

		const manager = new SessionManager(db, stubStorage())
		let sessionId: string
		try {
			const session = await manager.createSession(workspaceId, {
				actorId,
				actionPrompt: 'seed',
				createdBy: actorId,
				autoStart: false,
				initiatedFromObjectId: bet.id,
				initiatedFromObjectType: 'bet',
			})
			sessionId = session.id
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
		expect(row?.initiatedFromObjectId).toBe(bet.id)
		expect(row?.initiatedFromObjectType).toBe('bet')
	})

	it('leaves both columns NULL when the caller passes null (§3.4 NULL-safe posture)', async () => {
		const manager = new SessionManager(db, stubStorage())
		let sessionId: string
		try {
			const session = await manager.createSession(workspaceId, {
				actorId,
				actionPrompt: 'seed',
				createdBy: actorId,
				autoStart: false,
				initiatedFromObjectId: null,
				initiatedFromObjectType: null,
			})
			sessionId = session.id
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
		expect(row?.initiatedFromObjectId).toBeNull()
		expect(row?.initiatedFromObjectType).toBeNull()
	})

	it('nulls the column when the originating object is deleted (ON DELETE SET NULL cascade)', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'Cascade bet',
		})

		const manager = new SessionManager(db, stubStorage())
		let sessionId: string
		try {
			const session = await manager.createSession(workspaceId, {
				actorId,
				actionPrompt: 'seed',
				createdBy: actorId,
				autoStart: false,
				initiatedFromObjectId: bet.id,
				initiatedFromObjectType: 'bet',
			})
			sessionId = session.id
		} finally {
			await manager.stop()
		}

		await db.delete(objects).where(eq(objects.id, bet.id))

		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
		expect(row?.initiatedFromObjectId).toBeNull()
		// Type is deliberately NOT cascaded — it's a plain text tag, not an
		// FK, so a deleted object clears the reference but the row still
		// remembers what kind of thing it was spawned for.
		expect(row?.initiatedFromObjectType).toBe('bet')
	})

	it('emits runtime_session_ended with context_object_id + context_object_type when the session carries an originating object', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'Failure bet',
		})

		const { telemetry, captured } = stubTelemetry()
		const manager = new SessionManager(db, stubStorage(), telemetry)
		try {
			const session = await manager.createSession(workspaceId, {
				actorId,
				actionPrompt: 'will fail',
				createdBy: actorId,
				autoStart: false,
				initiatedFromObjectId: bet.id,
				initiatedFromObjectType: 'bet',
			})

			// Move the session to a non-terminal state, then fire the
			// container-loss path — that's the shortest public method that
			// records a runtime_session_ended for a failed session without
			// requiring Docker.
			await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, session.id))
			await manager.markSessionFailedAfterContainerLoss(session.id, workspaceId)
		} finally {
			await manager.stop()
		}

		const ended = captured.find((c) => c.event === 'runtime_session_ended')
		expect(ended).toBeDefined()
		expect(ended?.properties?.context_object_id).toBe(bet.id)
		expect(ended?.properties?.context_object_type).toBe('bet')
		expect(ended?.properties?.end_reason).toBe('failed')
	})

	it('omits both context properties from runtime_session_ended when the session has no originating object (NULL-safe payload)', async () => {
		const { telemetry, captured } = stubTelemetry()
		const manager = new SessionManager(db, stubStorage(), telemetry)
		try {
			const session = await manager.createSession(workspaceId, {
				actorId,
				actionPrompt: 'will fail (unlinked)',
				createdBy: actorId,
				autoStart: false,
				initiatedFromObjectId: null,
				initiatedFromObjectType: null,
			})
			await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, session.id))
			await manager.markSessionFailedAfterContainerLoss(session.id, workspaceId)
		} finally {
			await manager.stop()
		}

		const ended = captured.find((c) => c.event === 'runtime_session_ended')
		expect(ended).toBeDefined()
		// Absent, not null — spec §3.5.1 gates emission on contextObjectId
		// so downstream dashboards see a clean absence rather than a null
		// value that reads as "we had context but chose null".
		expect(ended?.properties).toBeDefined()
		expect('context_object_id' in (ended?.properties ?? {})).toBe(false)
		expect('context_object_type' in (ended?.properties ?? {})).toBe(false)
	})

	it('emits both a session_failed event AND a runtime_session_ended payload with context when the remote-dispatch enqueue path fails (spec §3.5.3, new site at 839)', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			title: 'Task 839',
		})

		const { telemetry, captured } = stubTelemetry()
		const manager = new SessionManager(db, stubStorage(), telemetry)
		// Wire a dispatch queue whose enqueue throws — that puts startSession
		// through the exact branch the new site at line 839 covers.
		manager.setDispatchQueue({
			async enqueue() {
				throw new Error('queue full')
			},
		} as unknown as import('../../services/session-dispatch-queue').SessionDispatchQueue)

		let sessionId: string
		try {
			const session = await manager.createSession(workspaceId, {
				actorId,
				actionPrompt: 'enqueue will fail',
				createdBy: actorId,
				autoStart: false,
				initiatedFromObjectId: bet.id,
				initiatedFromObjectType: 'task',
			})
			sessionId = session.id
			await expect(manager.startSession(session.id)).rejects.toThrow('queue full')
		} finally {
			await manager.stop()
		}

		// (a) session_failed event carries the initiated_from block —
		// the emitter enrichment (spec §3.4).
		const [failedEvent] = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, sessionId), eq(events.action, 'session_failed')))
		expect(failedEvent).toBeDefined()
		const data = failedEvent?.data as {
			initiated_from?: { object_id: string; object_type: string; object_title: string } | null
		}
		expect(data?.initiated_from?.object_id).toBe(bet.id)
		expect(data?.initiated_from?.object_type).toBe('task')
		expect(data?.initiated_from?.object_title).toBe('Task 839')

		// (b) runtime_session_ended fired — the new telemetry site at 839,
		// which was a hole today (this path never emitted).
		const ended = captured.find((c) => c.event === 'runtime_session_ended')
		expect(ended).toBeDefined()
		expect(ended?.properties?.session_id).toBe(sessionId)
		expect(ended?.properties?.end_reason).toBe('failed')
		expect(ended?.properties?.context_object_id).toBe(bet.id)
		expect(ended?.properties?.context_object_type).toBe('task')
	})

	// The parent task (06679c31) threaded runtime_session_ended through the 8
	// local-path sites. `markRemoteSessionComplete` is the production
	// remote-dispatch completion callback and was left uncovered — every
	// dispatch-created session's terminal transition on prod flows through it,
	// so without these emissions Criterion 3's numerator undercounts in prod.
	// These three cases pin the new remote-completion site: write path,
	// NULL-safe payload, and no-duplicate-emission on the dropped-signal path.
	it('emits runtime_session_ended with context_object_id + context_object_type when markRemoteSessionComplete lands the terminal transition', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'Remote complete bet',
		})
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			initiatedFromObjectId: bet.id,
			initiatedFromObjectType: 'bet',
		})

		const { telemetry, captured } = stubTelemetry()
		const manager = new SessionManager(db, stubStorage(), telemetry)
		try {
			await manager.markRemoteSessionComplete(session.id, 0)
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('completed')

		const ended = captured.find((c) => c.event === 'runtime_session_ended')
		expect(ended).toBeDefined()
		expect(ended?.properties?.session_id).toBe(session.id)
		expect(ended?.properties?.end_reason).toBe('completed')
		expect(ended?.properties?.context_object_id).toBe(bet.id)
		expect(ended?.properties?.context_object_type).toBe('bet')
	})

	it('omits both context properties from runtime_session_ended when markRemoteSessionComplete runs on a session with no originating object', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			initiatedFromObjectId: null,
			initiatedFromObjectType: null,
		})

		const { telemetry, captured } = stubTelemetry()
		const manager = new SessionManager(db, stubStorage(), telemetry)
		try {
			await manager.markRemoteSessionComplete(session.id, 0)
		} finally {
			await manager.stop()
		}

		const ended = captured.find((c) => c.event === 'runtime_session_ended')
		expect(ended).toBeDefined()
		expect(ended?.properties?.end_reason).toBe('completed')
		// Absent, not null — matches the naming split established by parent
		// task 06679c31 so downstream PostHog dashboards see a clean absence
		// rather than a null value that reads as "we had context but chose null".
		expect('context_object_id' in (ended?.properties ?? {})).toBe(false)
		expect('context_object_type' in (ended?.properties ?? {})).toBe(false)
	})

	it('does not fire a second runtime_session_ended when markRemoteSessionComplete is called on an already-terminal session (dropped-signal path)', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'Dropped-signal bet',
		})
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			initiatedFromObjectId: bet.id,
			initiatedFromObjectType: 'bet',
		})

		const { telemetry, captured } = stubTelemetry()
		const manager = new SessionManager(db, stubStorage(), telemetry)
		try {
			// First call takes the CAS-successful branch and emits.
			await manager.markRemoteSessionComplete(session.id, 0)
			// Second call takes the no-op "already terminal" branch at ~5220
			// (dropped-signal main path) — the CAS matches zero rows, `updated`
			// is undefined, and the method returns true without a terminal
			// transition. That branch must not fire a second telemetry event.
			await manager.markRemoteSessionComplete(session.id, 1)
		} finally {
			await manager.stop()
		}

		const endedEvents = captured.filter((c) => c.event === 'runtime_session_ended')
		expect(endedEvents).toHaveLength(1)
		expect(endedEvents[0]?.properties?.end_reason).toBe('completed')
	})
})
