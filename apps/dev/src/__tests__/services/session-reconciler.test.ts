import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as sessionLifecycle from '../../services/session-lifecycle'
import { SessionReconciler } from '../../services/session-reconciler'

function deepContainsValue(obj: unknown, target: string, seen = new Set<unknown>()): boolean {
	if (obj === target) return true
	if (typeof obj !== 'object' || obj === null || seen.has(obj)) return false
	seen.add(obj)
	return Object.values(obj).some((v) => deepContainsValue(v, target, seen))
}

interface Candidate {
	id: string
	workspaceId: string
	actorId: string
	containerId: string | null
	status: string
}

/**
 * Post-settleSession migration the reconciler doesn't write directly to
 * `sessions` — it calls `settleSession()`, which owns the SELECT+UPDATE+event
 * insert inside its own transaction. The unit tests here don't need to prove
 * settleSession's own behaviour (that lives in the integration suite); they
 * only need to prove the reconciler routes the right sessions to it with the
 * right classification. So we spy on settleSession, record the calls, and
 * synthesise the `alreadySettled` flag the reconciler branches on.
 */
function makeFakeDb(candidates: Candidate[]) {
	const updates: Array<{ values: Record<string, unknown>; where: unknown }> = []
	const eventsInserted: Array<Record<string, unknown>> = []

	const db = {
		select: () => ({
			from: () => ({
				where: () => Promise.resolve(candidates),
			}),
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: (predicate: unknown) => ({
					returning: () => {
						updates.push({ values, where: predicate })
						return Promise.resolve([{ id: 'updated' }])
					},
				}),
			}),
		}),
		insert: () => ({
			values: (row: Record<string, unknown>) => {
				eventsInserted.push(row)
				return Promise.resolve()
			},
		}),
	}

	return { db, updates, eventsInserted }
}

let settleCalls: Array<{ sessionId: string; outcome: sessionLifecycle.SettleOutcome }>
let settleShouldThrowFor: string | null

vi.mock('../../services/session-lifecycle', async (importOriginal) => {
	const actual = (await importOriginal()) as typeof sessionLifecycle
	return {
		...actual,
		settleSession: vi.fn(),
	}
})

beforeEach(() => {
	settleCalls = []
	settleShouldThrowFor = null
	vi.mocked(sessionLifecycle.settleSession).mockImplementation(
		async (sessionId: string, outcome: sessionLifecycle.SettleOutcome) => {
			settleCalls.push({ sessionId, outcome })
			if (settleShouldThrowFor === sessionId) {
				throw new Error('db blew up')
			}
			return {
				sessionId,
				finalStatus: 'failed',
				alreadySettled: false,
				stoppedSandbox: 'skipped-none-live',
				pushedAgentFiles: 'skipped-no-workspace',
				posthogEmitted: false,
				events: {},
			}
		},
	)
})

const agentServerId = '11111111-1111-1111-1111-111111111111'

describe('SessionReconciler.reconcile', () => {
	it('marks active sessions whose containerId is missing from the agent-server snapshot as failed', async () => {
		const { db, updates, eventsInserted } = makeFakeDb([
			{
				id: 'session-lost',
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				containerId: 'sandbox-lost',
				status: 'running',
			},
			{
				id: 'session-alive',
				workspaceId: 'ws-1',
				actorId: 'actor-2',
				containerId: 'sandbox-alive',
				status: 'running',
			},
		])

		const reconciler = new SessionReconciler(db as never)
		const result = await reconciler.reconcile({
			agentServerId,
			sandboxes: ['sandbox-alive'],
		})

		expect(result.markedFailed).toEqual(['session-lost'])
		expect(result.orphanSandboxes).toEqual([])

		// The reconciler delegates the terminal write to settleSession —
		// verify it was called for the lost session with the right kind,
		// classification, source, and failure_reason. settleSession's own
		// SELECT + UPDATE + event emission is covered by session-lifecycle
		// integration tests, not here.
		expect(settleCalls).toHaveLength(1)
		expect(settleCalls[0]?.sessionId).toBe('session-lost')
		expect(settleCalls[0]?.outcome).toMatchObject({
			kind: 'fail',
			classification: 'sandbox_crash',
			source: 'reconciler',
			failureReason: { reason_code: 'agent_server_lost' },
		})
		// updates/eventsInserted stay empty — the writes now live inside
		// settleSession's transaction, which the mock never enters.
		expect(updates).toHaveLength(0)
		expect(eventsInserted).toHaveLength(0)
	})

	it('writes the failure reason into the session transcript', async () => {
		// `result.failure_reason` only renders once the session detail panel is
		// open. A user watching the live log stream of a session whose sandbox
		// was lost otherwise just sees it stop mid-sentence.
		const { db } = makeFakeDb([
			{
				id: 'session-lost',
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				containerId: 'sandbox-lost',
				status: 'running',
			},
		])
		const appendSystemLog = vi.fn().mockResolvedValue(undefined)

		const reconciler = new SessionReconciler(db as never, appendSystemLog)
		await reconciler.reconcile({ agentServerId, sandboxes: [] })

		expect(appendSystemLog).toHaveBeenCalledWith(
			'session-lost',
			expect.stringMatching(/agent server restarted.*start a new session/i),
		)
	})

	it('still marks the session failed when the transcript write throws', async () => {
		// A session left non-terminal holds its capacity slot until the timeout
		// backstop — strictly worse than a missing log line.
		const { db, updates } = makeFakeDb([
			{
				id: 'session-lost',
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				containerId: 'sandbox-lost',
				status: 'running',
			},
		])

		const reconciler = new SessionReconciler(
			db as never,
			vi.fn().mockRejectedValue(new Error('log write failed')),
		)
		const result = await reconciler.reconcile({ agentServerId, sandboxes: [] })

		expect(result.markedFailed).toEqual(['session-lost'])
		expect(settleCalls[0]?.outcome).toMatchObject({ kind: 'fail' })
		// updates array is unused now — settleSession owns the write.
		void updates
	})

	it('returns sandbox names the DB does not claim as orphans for the caller to remove', async () => {
		const { db } = makeFakeDb([
			{
				id: 'session-alive',
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				containerId: 'sandbox-alive',
				status: 'running',
			},
		])

		const reconciler = new SessionReconciler(db as never)
		const result = await reconciler.reconcile({
			agentServerId,
			sandboxes: ['sandbox-alive', 'sandbox-orphan-a', 'sandbox-orphan-b'],
		})

		expect(result.markedFailed).toEqual([])
		expect(result.orphanSandboxes).toEqual(['sandbox-orphan-a', 'sandbox-orphan-b'])
	})

	it('skips a session whose update throws but still processes the others', async () => {
		const candidates: Candidate[] = [
			{
				id: 'session-one',
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				containerId: 'sandbox-one',
				status: 'running',
			},
			{
				id: 'session-two',
				workspaceId: 'ws-1',
				actorId: 'actor-2',
				containerId: 'sandbox-two',
				status: 'running',
			},
		]
		const db = {
			select: () => ({ from: () => ({ where: () => Promise.resolve(candidates) }) }),
			update: () => ({
				set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
			}),
			insert: () => ({ values: () => Promise.resolve() }),
		}

		settleShouldThrowFor = 'session-one'

		const reconciler = new SessionReconciler(db as never)
		const result = await reconciler.reconcile({ agentServerId, sandboxes: [] })

		// One settle call succeeded (session-two), the other threw and its
		// session id stayed off `markedFailed`.
		expect(result.markedFailed).toEqual(['session-two'])
		expect(settleCalls.map((c) => c.sessionId).sort()).toEqual(['session-one', 'session-two'])
	})

	it('returns empty arrays when the snapshot matches the DB exactly', async () => {
		const { db, updates, eventsInserted } = makeFakeDb([
			{
				id: 'session-a',
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				containerId: 'sandbox-a',
				status: 'running',
			},
		])

		const reconciler = new SessionReconciler(db as never)
		const result = await reconciler.reconcile({ agentServerId, sandboxes: ['sandbox-a'] })

		expect(result).toEqual({ markedFailed: [], orphanSandboxes: [] })
		expect(updates).toHaveLength(0)
		expect(eventsInserted).toHaveLength(0)
	})

	it('does not orphan a live snapshotting/waiting_for_input sandbox nor mark it failed', async () => {
		const { db, updates, eventsInserted } = makeFakeDb([
			{
				id: 'session-snapshotting',
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				containerId: 'sandbox-snapshotting',
				status: 'snapshotting',
			},
			{
				id: 'session-waiting',
				workspaceId: 'ws-1',
				actorId: 'actor-2',
				containerId: 'sandbox-waiting',
				status: 'waiting_for_input',
			},
		])

		const reconciler = new SessionReconciler(db as never)
		const result = await reconciler.reconcile({
			agentServerId,
			// The agent-server still reports both live sandboxes.
			sandboxes: ['sandbox-snapshotting', 'sandbox-waiting'],
		})

		// Neither is failable, and both are claimed — so nothing is touched and
		// the caller is never told to `msb remove -f` a live sandbox.
		expect(result.markedFailed).toEqual([])
		expect(result.orphanSandboxes).toEqual([])
		expect(updates).toHaveLength(0)
		expect(eventsInserted).toHaveLength(0)
	})

	it('scopes the DB query to the given agentServerId', async () => {
		let capturedWhere: unknown
		const db = {
			select: () => ({
				from: () => ({
					where: (pred: unknown) => {
						capturedWhere = pred
						return Promise.resolve([])
					},
				}),
			}),
			update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
			insert: () => ({ values: () => Promise.resolve() }),
		}

		const reconciler = new SessionReconciler(db as never)
		await reconciler.reconcile({ agentServerId, sandboxes: [] })

		// The WHERE predicate must reference the agentServerId so that on a
		// multi-server deployment each agent-server only sees its own sessions.
		// We do a cycle-safe deep search since Drizzle SQL objects contain
		// circular table references that prevent JSON.stringify.
		expect(capturedWhere).toBeDefined()
		expect(deepContainsValue(capturedWhere, agentServerId)).toBe(true)
	})

	it('handles an empty DB and empty snapshot without writes', async () => {
		const selectSpy = vi.fn().mockResolvedValue([])
		const updateSpy = vi.fn()
		const insertSpy = vi.fn()
		const db = {
			select: () => ({ from: () => ({ where: selectSpy }) }),
			update: () => ({ set: updateSpy, where: updateSpy }),
			insert: () => ({ values: insertSpy }),
		}

		const reconciler = new SessionReconciler(db as never)
		const result = await reconciler.reconcile({ agentServerId, sandboxes: [] })

		expect(result).toEqual({ markedFailed: [], orphanSandboxes: [] })
		expect(updateSpy).not.toHaveBeenCalled()
		expect(insertSpy).not.toHaveBeenCalled()
	})
})
