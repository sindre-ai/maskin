import {
	type BetLike,
	type ChildTaskLike,
	type ObjectLike,
	STALLED_THRESHOLD_MS,
	WORK_STATE_WEIGHT,
	classifyBetStatus,
	classifyObjectWorkState,
} from '@/lib/bet-status'
import { describe, expect, it } from 'vitest'

const BET: BetLike = { id: 'bet-1', type: 'bet', status: 'active' }
const NOW = new Date('2026-07-02T13:00:00Z')

function task(overrides: Partial<ChildTaskLike> & { id: string }): ChildTaskLike {
	return {
		type: 'task',
		title: `Task ${overrides.id}`,
		status: 'todo',
		driver: null,
		metadata: null,
		updatedAt: NOW.toISOString(),
		activeSessionId: null,
		...overrides,
	}
}

describe('classifyBetStatus', () => {
	it('returns idle when there are no child tasks', () => {
		const result = classifyBetStatus(BET, [], NOW)
		expect(result.state).toBe('idle')
		expect(result.pendingAction).toBeNull()
		expect(result.decisionsSoFar).toEqual([])
	})

	it('returns idle when all child tasks are todo and recent', () => {
		const tasks = [task({ id: 't1', status: 'todo' })]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('idle')
		expect(result.pendingAction).toBeNull()
	})

	it('returns progressing when a child task is in_progress with a live agent session', () => {
		const tasks = [
			task({
				id: 't1',
				status: 'in_progress',
				title: 'Ship it',
				driver: 'agent-1',
				activeSessionId: 'session-1',
			}),
			task({ id: 't2', status: 'todo' }),
		]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('progressing')
		expect(result.pendingAction?.kind).toBe('progressing')
		expect(result.pendingAction?.tasks).toEqual([
			{ id: 't1', title: 'Ship it', driver: 'agent-1', status: 'in_progress' },
		])
	})

	it('returns progressing when a child task is in_review with a live agent session', () => {
		const tasks = [task({ id: 't1', status: 'in_review', activeSessionId: 'session-1' })]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('progressing')
		expect(result.pendingAction?.tasks).toHaveLength(1)
	})

	it('does not treat in_progress as progressing when there is no live agent session', () => {
		const tasks = [task({ id: 't1', status: 'in_progress', activeSessionId: null })]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('idle')
		expect(result.pendingAction).toBeNull()
	})

	it('falls through to stalled when an in_progress task lost its session and gone stale', () => {
		const oldTimestamp = new Date(NOW.getTime() - STALLED_THRESHOLD_MS - 1000).toISOString()
		const tasks = [
			task({
				id: 't1',
				status: 'in_progress',
				activeSessionId: null,
				updatedAt: oldTimestamp,
			}),
		]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('stalled')
	})

	it('returns waiting_on_human when an open task has metadata.human_decision', () => {
		const tasks = [
			task({ id: 't1', status: 'in_progress' }),
			task({
				id: 't2',
				status: 'todo',
				title: 'Approve deploy?',
				metadata: { human_decision: true },
			}),
		]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('waiting_on_human')
		expect(result.pendingAction?.kind).toBe('waiting_on_human')
		expect(result.pendingAction?.tasks.map((t) => t.id)).toEqual(['t2'])
	})

	it('waiting_on_human wins over progressing when both signals are present', () => {
		const tasks = [
			task({ id: 't1', status: 'in_progress', activeSessionId: 'session-1' }),
			task({ id: 't2', status: 'in_review', activeSessionId: 'session-2' }),
			task({ id: 't3', status: 'todo', metadata: { human_decision: true } }),
		]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('waiting_on_human')
	})

	it('does not treat a resolved human_decision as waiting', () => {
		const tasks = [task({ id: 't1', status: 'done', metadata: { human_decision: true } })]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('idle')
	})

	it('waiting_on_human only fires when metadata.human_decision === true', () => {
		const tasks = [task({ id: 't1', status: 'todo', metadata: { human_decision: false } })]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('idle')
	})

	it('narrow-gate boundary: a truthy but non-true value does not count as waiting', () => {
		const tasks = [
			task({ id: 't1', status: 'todo', metadata: { human_decision: 'true' } }),
			task({ id: 't2', status: 'todo', metadata: { human_decision: 1 } }),
		]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('idle')
	})

	it('returns stalled when no WIP and newest task is older than 72h', () => {
		const oldTimestamp = new Date(NOW.getTime() - STALLED_THRESHOLD_MS - 1000).toISOString()
		const tasks = [task({ id: 't1', status: 'todo', updatedAt: oldTimestamp })]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('stalled')
		expect(result.pendingAction).toBeNull()
	})

	it('stays idle when newest task is exactly at the 72h threshold', () => {
		const boundary = new Date(NOW.getTime() - STALLED_THRESHOLD_MS).toISOString()
		const tasks = [task({ id: 't1', status: 'todo', updatedAt: boundary })]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('idle')
	})

	it('progressing wins over stalled when a WIP task with a live session is old', () => {
		const oldTimestamp = new Date(NOW.getTime() - STALLED_THRESHOLD_MS - 1000).toISOString()
		const tasks = [
			task({
				id: 't1',
				status: 'in_progress',
				activeSessionId: 'session-1',
				updatedAt: oldTimestamp,
			}),
		]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('progressing')
	})

	it('decisionsSoFar lists resolved human_decision tasks newest first', () => {
		const tasks = [
			task({
				id: 't1',
				status: 'done',
				title: 'Older decision',
				metadata: { human_decision: true },
				updatedAt: '2026-06-01T00:00:00Z',
			}),
			task({
				id: 't2',
				status: 'done',
				title: 'Newer decision',
				metadata: { human_decision: true },
				updatedAt: '2026-06-15T00:00:00Z',
			}),
			task({ id: 't3', status: 'done', metadata: { human_decision: false } }),
		]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.decisionsSoFar).toEqual([
			{ taskId: 't2', title: 'Newer decision', decidedAt: '2026-06-15T00:00:00Z' },
			{ taskId: 't1', title: 'Older decision', decidedAt: '2026-06-01T00:00:00Z' },
		])
	})

	it('decisionsSoFar is returned alongside every state, not only waiting', () => {
		const tasks = [
			task({ id: 't1', status: 'in_progress', activeSessionId: 'session-1' }),
			task({
				id: 't2',
				status: 'done',
				metadata: { human_decision: true },
				updatedAt: '2026-06-10T00:00:00Z',
			}),
		]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('progressing')
		expect(result.decisionsSoFar).toHaveLength(1)
		expect(result.decisionsSoFar[0].taskId).toBe('t2')
	})

	it('ignores child objects that are not tasks', () => {
		const tasks: ChildTaskLike[] = [
			{ ...task({ id: 'i1', status: 'in_progress' }), type: 'insight' },
		]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('idle')
	})

	it('handles a null updatedAt without throwing when computing staleness', () => {
		const tasks = [task({ id: 't1', status: 'todo', updatedAt: null })]
		const result = classifyBetStatus(BET, tasks, NOW)
		expect(result.state).toBe('idle')
	})
})

function object(overrides: Partial<ObjectLike> & { id: string; type: string }): ObjectLike {
	return {
		status: 'todo',
		metadata: null,
		updatedAt: NOW.toISOString(),
		activeSessionId: null,
		...overrides,
	}
}

describe('classifyObjectWorkState', () => {
	it('waiting_on_human wins for open objects flagged with human_decision', () => {
		const obj = object({
			id: 'i1',
			type: 'insight',
			status: 'todo',
			metadata: { human_decision: true },
		})
		expect(classifyObjectWorkState(obj, NOW)).toBe('waiting_on_human')
	})

	it('progressing when the object has a live session', () => {
		const obj = object({
			id: 't1',
			type: 'task',
			status: 'in_progress',
			activeSessionId: 'session-1',
		})
		expect(classifyObjectWorkState(obj, NOW)).toBe('progressing')
	})

	it('stalled when open but last update is older than 72h', () => {
		const old = new Date(NOW.getTime() - STALLED_THRESHOLD_MS - 1000).toISOString()
		const obj = object({ id: 't1', type: 'task', status: 'todo', updatedAt: old })
		expect(classifyObjectWorkState(obj, NOW)).toBe('stalled')
	})

	it('idle for done and archived rows regardless of other signals', () => {
		const done = object({
			id: 't1',
			type: 'task',
			status: 'done',
			metadata: { human_decision: true },
			activeSessionId: 'session-1',
		})
		const archived = object({ id: 't2', type: 'task', status: 'archived' })
		expect(classifyObjectWorkState(done, NOW)).toBe('idle')
		expect(classifyObjectWorkState(archived, NOW)).toBe('idle')
	})

	it('idle when nothing else fires — recent open row without a live session', () => {
		const obj = object({ id: 'i1', type: 'insight', status: 'todo' })
		expect(classifyObjectWorkState(obj, NOW)).toBe('idle')
	})

	it('WORK_STATE_WEIGHT orders waiting → stalled → progressing → idle', () => {
		expect(WORK_STATE_WEIGHT.waiting_on_human).toBeLessThan(WORK_STATE_WEIGHT.stalled)
		expect(WORK_STATE_WEIGHT.stalled).toBeLessThan(WORK_STATE_WEIGHT.progressing)
		expect(WORK_STATE_WEIGHT.progressing).toBeLessThan(WORK_STATE_WEIGHT.idle)
	})
})
