import { events, loopOutputApprovals, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { LoopExecutionBlockedError } from '../../lib/loop-execution-gate'
import { SessionManager } from '../../services/session-manager'
import {
	insertActor,
	insertObject,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
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
 * T4 (bet/loop-lifecycle-status-ladder) — session-boundary enforcement of the
 * loop lifecycle:
 *   - Blocking gate: `draft | paused | archived` → session creation refused.
 *   - Supervised gate: `supervised` → session runs, terminal output held in
 *     the T7 approval queue instead of delivered.
 *   - `pilot` and `live` (and standalone triggers, and triggerless
 *     sessions) are unconditional pass-through.
 *
 * Real-Postgres coverage of the reverse-lookup and both gates, matching the
 * bet's `paused → zero sessions` and `supervised → held output` acceptance
 * criteria against migration-replayed schema (unit tests with mocked DB
 * cannot cover the jsonb `metadata->'trigger_ids' ? $triggerId` predicate
 * this file's helper depends on).
 */
describe('Loop execution gate — session creation + supervised approval enqueue (Integration)', () => {
	let workspaceId: string
	let actorId: string
	let driverActorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		const driver = await insertActor(db, { type: 'agent', name: 'Loop Driver' })
		driverActorId = driver.id
	})

	async function makeLoopWithTrigger(loopStatus: string) {
		const trigger = await insertTrigger(db, workspaceId, actorId, driverActorId, {
			type: 'cron',
			config: { expression: '0 * * * *' },
		})
		const loop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: loopStatus,
			title: `Loop in ${loopStatus}`,
			metadata: { trigger_ids: [trigger.id] },
		})
		return { trigger, loop }
	}

	describe('blocking gate — draft/paused/archived produce zero sessions', () => {
		for (const blockedStatus of ['draft', 'paused', 'archived']) {
			it(`refuses createSession when parent loop is ${blockedStatus}`, async () => {
				const { trigger, loop } = await makeLoopWithTrigger(blockedStatus)
				const manager = new SessionManager(db, stubStorage())

				try {
					await expect(
						manager.createSession(workspaceId, {
							actorId: driverActorId,
							actionPrompt: 'do the thing',
							triggerId: trigger.id,
							createdBy: actorId,
							autoStart: false,
						}),
					).rejects.toBeInstanceOf(LoopExecutionBlockedError)
				} finally {
					await manager.stop()
				}

				const rows = await db
					.select({ id: sessions.id })
					.from(sessions)
					.where(eq(sessions.triggerId, trigger.id))
				expect(rows).toHaveLength(0)

				const createdEvents = await db
					.select({ id: events.id })
					.from(events)
					.where(and(eq(events.entityType, 'session'), eq(events.action, 'session_created')))
				expect(createdEvents).toHaveLength(0)

				// LoopExecutionBlockedError should carry the loop id + status so
				// the sessions route can 409 with a useful body.
				try {
					const otherManager = new SessionManager(db, stubStorage())
					try {
						await otherManager.createSession(workspaceId, {
							actorId: driverActorId,
							actionPrompt: 'do the thing',
							triggerId: trigger.id,
							createdBy: actorId,
							autoStart: false,
						})
					} finally {
						await otherManager.stop()
					}
					throw new Error('expected LoopExecutionBlockedError')
				} catch (err) {
					expect(err).toBeInstanceOf(LoopExecutionBlockedError)
					const blockErr = err as LoopExecutionBlockedError
					expect(blockErr.loopId).toBe(loop.id)
					expect(blockErr.loopStatus).toBe(blockedStatus)
				}
			})
		}
	})

	describe('allow gate — pilot/live/supervised/no-loop create sessions', () => {
		for (const runningStatus of ['pilot', 'live', 'supervised']) {
			it(`creates a session when parent loop is ${runningStatus}`, async () => {
				const { trigger } = await makeLoopWithTrigger(runningStatus)
				const manager = new SessionManager(db, stubStorage())

				let session: Awaited<ReturnType<SessionManager['createSession']>>
				try {
					session = await manager.createSession(workspaceId, {
						actorId: driverActorId,
						actionPrompt: 'do the thing',
						triggerId: trigger.id,
						createdBy: actorId,
						autoStart: false,
					})
				} finally {
					await manager.stop()
				}

				expect(session.id).toBeTruthy()
				const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
				expect(row?.triggerId).toBe(trigger.id)
			})
		}

		it('creates a session for a standalone trigger with no parent loop', async () => {
			const trigger = await insertTrigger(db, workspaceId, actorId, driverActorId)
			const manager = new SessionManager(db, stubStorage())

			try {
				const session = await manager.createSession(workspaceId, {
					actorId: driverActorId,
					actionPrompt: 'do the thing',
					triggerId: trigger.id,
					createdBy: actorId,
					autoStart: false,
				})
				expect(session.id).toBeTruthy()
			} finally {
				await manager.stop()
			}
		})

		it('creates a session when no triggerId is passed', async () => {
			const manager = new SessionManager(db, stubStorage())

			try {
				const session = await manager.createSession(workspaceId, {
					actorId: driverActorId,
					actionPrompt: 'ad-hoc run',
					createdBy: actorId,
					autoStart: false,
				})
				expect(session.id).toBeTruthy()
			} finally {
				await manager.stop()
			}
		})
	})

	describe('supervised output gate — completion enqueues loop_output_approvals', () => {
		it('enqueues a pending approval row when a supervised-loop session completes', async () => {
			const { trigger, loop } = await makeLoopWithTrigger('supervised')
			const session = await insertSession(db, workspaceId, driverActorId, actorId, {
				status: 'running',
				triggerId: trigger.id,
				actionPrompt: 'summarize inbox',
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await manager.markRemoteSessionComplete(session.id, 0)
			} finally {
				await manager.stop()
			}

			const approvals = await db
				.select()
				.from(loopOutputApprovals)
				.where(eq(loopOutputApprovals.sessionId, session.id))
			expect(approvals).toHaveLength(1)
			const approval = approvals[0]
			expect(approval.status).toBe('pending')
			expect(approval.loopId).toBe(loop.id)
			expect(approval.driverActorId).toBe(driverActorId)
			expect(approval.workspaceId).toBe(workspaceId)
			expect(approval.payload).toMatchObject({
				session_id: session.id,
				exit_code: 0,
				action_prompt_excerpt: 'summarize inbox',
			})

			const auditRows = await db
				.select({ id: events.id, action: events.action })
				.from(events)
				.where(and(eq(events.entityType, 'loop_output_approval'), eq(events.entityId, approval.id)))
			expect(auditRows).toHaveLength(1)
			expect(auditRows[0]?.action).toBe('created')
		})

		it('is idempotent — a double completion signal only enqueues one approval', async () => {
			const { trigger, loop } = await makeLoopWithTrigger('supervised')
			const session = await insertSession(db, workspaceId, driverActorId, actorId, {
				status: 'running',
				triggerId: trigger.id,
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await manager.markRemoteSessionComplete(session.id, 0)
				// A second call — e.g. a stop write followed by the genuine
				// completion report — must not enqueue a second row.
				await manager.markRemoteSessionComplete(session.id, 0)
			} finally {
				await manager.stop()
			}

			const approvals = await db
				.select({ id: loopOutputApprovals.id })
				.from(loopOutputApprovals)
				.where(
					and(
						eq(loopOutputApprovals.sessionId, session.id),
						eq(loopOutputApprovals.loopId, loop.id),
					),
				)
			expect(approvals).toHaveLength(1)
		})

		for (const runningStatus of ['pilot', 'live']) {
			it(`does NOT enqueue an approval when the loop is ${runningStatus}`, async () => {
				const { trigger } = await makeLoopWithTrigger(runningStatus)
				const session = await insertSession(db, workspaceId, driverActorId, actorId, {
					status: 'running',
					triggerId: trigger.id,
				})

				const manager = new SessionManager(db, stubStorage())
				try {
					await manager.markRemoteSessionComplete(session.id, 0)
				} finally {
					await manager.stop()
				}

				const approvals = await db
					.select({ id: loopOutputApprovals.id })
					.from(loopOutputApprovals)
					.where(eq(loopOutputApprovals.sessionId, session.id))
				expect(approvals).toHaveLength(0)
			})
		}

		it('does NOT enqueue an approval when the session has no trigger id', async () => {
			const session = await insertSession(db, workspaceId, driverActorId, actorId, {
				status: 'running',
				triggerId: null,
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await manager.markRemoteSessionComplete(session.id, 0)
			} finally {
				await manager.stop()
			}

			const approvals = await db
				.select({ id: loopOutputApprovals.id })
				.from(loopOutputApprovals)
				.where(eq(loopOutputApprovals.sessionId, session.id))
			expect(approvals).toHaveLength(0)
		})
	})
})
