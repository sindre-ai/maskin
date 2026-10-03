// The reaper must stop reprocessing rows that already finished. Terminal rows
// whose session_state never reached 'done' used to be re-read by wall-timeout,
// queued-rescue and boot-stall on every 60s pass. These run against real
// Postgres because the behaviour lives in the WHERE clauses.

import { events, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { capturePosthogEvent } from '../../lib/analytics/posthog'
import {
	TRULY_TERMINAL_STATUSES,
	_driveToRunning,
	configureSessionLifecycle,
	settleSession,
} from '../../services/session-lifecycle'
import { SessionManager } from '../../services/session-manager'
import { insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(async () => undefined),
}))

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

type WatchdogHost = {
	runWatchdog(): Promise<void>
	drainQueue(id: string): Promise<void>
	pruneSessionLogs(): Promise<void>
}

function makeManager(): SessionManager {
	const manager = new SessionManager(db, stubStorage())
	configureSessionLifecycle({ db, sessionManager: manager })
	// The last pass step drains queued workspaces through the dispatcher, which
	// is out of scope here.
	vi.spyOn(manager as unknown as WatchdogHost, 'drainQueue').mockResolvedValue(undefined)
	return manager
}

const tick = (manager: SessionManager) => (manager as unknown as WatchdogHost).runWatchdog()

const readRow = async (id: string) => {
	const [row] = await db.select().from(sessions).where(eq(sessions.id, id))
	return row
}

const sixMinAgo = () => new Date(Date.now() - 6 * 60 * 1000)

describe('SessionManager.runWatchdog — settled rows (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		vi.mocked(capturePosthogEvent).mockClear()
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	describe('heal', () => {
		for (const status of TRULY_TERMINAL_STATUSES) {
			for (const staleState of ['queued', 'starting', 'running'] as const) {
				it(`heals a ${status} row stuck at ${staleState} to done without failing it`, async () => {
					const finishedAt = new Date(Date.now() - 60 * 60 * 1000)
					const session = await insertSession(db, workspaceId, actorId, actorId, {
						status,
						sessionState: staleState,
						stateEnteredAt: sixMinAgo(),
						startedAt: finishedAt,
						completedAt: finishedAt,
						updatedAt: finishedAt,
						timeoutAt: null,
					})

					const manager = makeManager()
					try {
						await tick(manager)
					} finally {
						await manager.stop()
					}

					const row = await readRow(session.id)
					expect(row?.sessionState).toBe('done')
					expect(row?.status).toBe(status)
					// updatedAt is the terminal-transition time the reconciler reads.
					expect(row?.updatedAt.getTime()).toBe(finishedAt.getTime())

					// The row never reached settle: no terminal event was written.
					const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
					expect(eventRows).toHaveLength(0)
				})
			}
		}

		it('leaves a live row alone', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				sessionState: 'running',
				startedAt: new Date(),
				timeoutAt: null,
			})

			const manager = makeManager()
			try {
				await tick(manager)
			} finally {
				await manager.stop()
			}

			const row = await readRow(session.id)
			expect(row?.status).toBe('running')
			expect(row?.sessionState).toBe('running')
		})
	})

	describe('boot-stall status filter', () => {
		it('never fails a row that turned running between the heal and the boot-stall read', async () => {
			const victim = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'starting',
				sessionState: 'starting',
				stateEnteredAt: sixMinAgo(),
				startedAt: sixMinAgo(),
				timeoutAt: null,
			})
			// A row waiting >24h makes the waiting-bound step (which runs after the
			// running-heal and before boot-stall) emit its PostHog signal. Use that
			// hook to flip the victim to running at the status level only, exactly
			// the window the boot-stall filter has to cover.
			await insertSession(db, workspaceId, actorId, actorId, {
				status: 'queued',
				sessionState: 'waiting_for_machine',
				stateEnteredAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
				startedAt: null,
				timeoutAt: null,
			})
			vi.mocked(capturePosthogEvent).mockImplementationOnce(async () => {
				await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, victim.id))
			})

			const manager = makeManager()
			try {
				await tick(manager)
			} finally {
				await manager.stop()
			}

			expect(capturePosthogEvent).toHaveBeenCalledWith(
				'session_waiting_stuck',
				expect.any(String),
				expect.anything(),
			)
			const row = await readRow(victim.id)
			expect(row?.status).toBe('running')
			const eventRows = await db.select().from(events).where(eq(events.entityId, victim.id))
			expect(eventRows.some((e) => e.action === 'session_failed')).toBe(false)
		})

		it('still fails a genuinely stalled starting row', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'starting',
				sessionState: 'starting',
				stateEnteredAt: sixMinAgo(),
				startedAt: sixMinAgo(),
				timeoutAt: null,
			})

			const manager = makeManager()
			try {
				await tick(manager)
			} finally {
				await manager.stop()
			}

			const row = await readRow(session.id)
			expect(row?.status).toBe('failed')
			expect(row?.sessionState).toBe('done')
		})
	})

	describe('settleSession on an already-terminal row', () => {
		it('stamps session_state done without rewriting the terminal status or emitting an event', async () => {
			const finishedAt = new Date(Date.now() - 60 * 60 * 1000)
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'completed',
				sessionState: 'starting',
				completedAt: finishedAt,
				updatedAt: finishedAt,
			})

			await settleSession(
				session.id,
				{ kind: 'fail', classification: 'startup_stalled', source: 'reaper' },
				{
					db,
					stopSandbox: async () => 'skipped-none-live' as const,
					pushAgentFiles: async () => 'skipped-no-workspace' as const,
				},
			)

			const row = await readRow(session.id)
			expect(row?.status).toBe('completed')
			expect(row?.sessionState).toBe('done')
			const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
			expect(eventRows).toHaveLength(0)
		})
	})

	describe('_driveToRunning status guard', () => {
		it('does not move a terminal row back to starting or running', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'completed',
				sessionState: 'queued',
				completedAt: new Date(),
			})

			const manager = makeManager()
			vi.spyOn(manager, 'startSession').mockResolvedValue(undefined as never)
			try {
				await _driveToRunning(session.id)
			} finally {
				await manager.stop()
			}

			const row = await readRow(session.id)
			expect(row?.sessionState).toBe('queued')
		})

		it('still drives a non-terminal queued row to running', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'queued',
				sessionState: 'queued',
				startedAt: null,
			})

			const manager = makeManager()
			vi.spyOn(manager, 'startSession').mockResolvedValue(undefined as never)
			try {
				await _driveToRunning(session.id)
			} finally {
				await manager.stop()
			}

			const row = await readRow(session.id)
			expect(row?.sessionState).toBe('running')
		})
	})

	describe('pass isolation', () => {
		it('runs later steps when an earlier step throws', async () => {
			// A running-status row stuck at queued is fixed by the running-heal,
			// which sits after the log-prune step in the pass.
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				sessionState: 'queued',
				startedAt: new Date(),
				timeoutAt: null,
			})

			const manager = makeManager()
			vi.spyOn(manager as unknown as WatchdogHost, 'pruneSessionLogs').mockRejectedValue(
				new Error('prune blew up'),
			)
			try {
				await expect(tick(manager)).resolves.toBeUndefined()
			} finally {
				await manager.stop()
			}

			const row = await readRow(session.id)
			expect(row?.sessionState).toBe('running')
		})

		it('skips a tick while the previous pass is still running', async () => {
			const manager = makeManager()
			let release: () => void = () => {}
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			const pruneSpy = vi
				.spyOn(manager as unknown as WatchdogHost, 'pruneSessionLogs')
				.mockImplementation(() => gate)
			try {
				const first = tick(manager)
				// Let the first pass reach the gated step.
				await vi.waitFor(() => expect(pruneSpy).toHaveBeenCalledTimes(1))
				await tick(manager)
				expect(pruneSpy).toHaveBeenCalledTimes(1)

				release()
				await first

				// The flag is released once the pass ends.
				await tick(manager)
				expect(pruneSpy).toHaveBeenCalledTimes(2)
			} finally {
				release()
				await manager.stop()
			}
		})
	})
})
