import { describe, expect, it, vi } from 'vitest'
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
				where: (predicate: unknown) => {
					updates.push({ values, where: predicate })
					return Promise.resolve()
				},
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

		expect(updates).toHaveLength(1)
		expect(updates[0]?.values).toMatchObject({
			status: 'failed',
			result: {
				exit_code: null,
				failure_reason: { reason_code: 'agent_server_lost' },
			},
			currentActivity: null,
		})

		expect(eventsInserted).toHaveLength(1)
		expect(eventsInserted[0]).toMatchObject({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			action: 'session_failed',
			entityType: 'session',
			entityId: 'session-lost',
		})
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
		let updateCall = 0
		const eventsInserted: Array<Record<string, unknown>> = []
		const db = {
			select: () => ({ from: () => ({ where: () => Promise.resolve(candidates) }) }),
			update: () => ({
				set: () => ({
					where: () => {
						updateCall++
						if (updateCall === 1) return Promise.reject(new Error('db blew up'))
						return Promise.resolve()
					},
				}),
			}),
			insert: () => ({
				values: (row: Record<string, unknown>) => {
					eventsInserted.push(row)
					return Promise.resolve()
				},
			}),
		}

		const reconciler = new SessionReconciler(db as never)
		const result = await reconciler.reconcile({ agentServerId, sandboxes: [] })

		expect(result.markedFailed).toEqual(['session-two'])
		expect(eventsInserted).toHaveLength(1)
		expect(eventsInserted[0]).toMatchObject({ entityId: 'session-two' })
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
