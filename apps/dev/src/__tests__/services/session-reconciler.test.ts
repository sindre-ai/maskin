import { describe, expect, it, vi } from 'vitest'
import { SessionReconciler } from '../../services/session-reconciler'

interface Candidate {
	id: string
	workspaceId: string
	actorId: string
	containerId: string | null
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
			},
			{
				id: 'session-alive',
				workspaceId: 'ws-1',
				actorId: 'actor-2',
				containerId: 'sandbox-alive',
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
			},
			{
				id: 'session-two',
				workspaceId: 'ws-1',
				actorId: 'actor-2',
				containerId: 'sandbox-two',
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
			},
		])

		const reconciler = new SessionReconciler(db as never)
		const result = await reconciler.reconcile({ agentServerId, sandboxes: ['sandbox-a'] })

		expect(result).toEqual({ markedFailed: [], orphanSandboxes: [] })
		expect(updates).toHaveLength(0)
		expect(eventsInserted).toHaveLength(0)
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
