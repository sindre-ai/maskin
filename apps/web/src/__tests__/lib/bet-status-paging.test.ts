import { fetchAllPages } from '@/lib/pagination'
import {
	type BetLike,
	type BreaksIntoRel,
	type ChildTaskLike,
	buildBetStatuses,
} from '@maskin/shared'
import { describe, expect, it, vi } from 'vitest'

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

/**
 * Regression test for the classifier's silent limit=50 ceiling — before the
 * pagination fix, `api.objects.list({ type: 'task' })` returned only the first
 * page of tasks. A bet whose child-task IDs fell into any later page was
 * misclassified as `idle` because the task lookup missed them entirely.
 */
describe('classifier + paged fetch', () => {
	it('classifies a bet as progressing when its child task lives past the first page', async () => {
		// Server-side default is limit=50, hard cap is 100. Simulate the shape
		// the client sees: 60 total tasks, paged 50 + 10. The bet's only child
		// task lives in page 2, so a single-page fetch would drop it entirely.
		const PAGE_SIZE = 50
		const TOTAL_TASKS = 60
		const IN_PROGRESS_TASK_INDEX = 55 // definitively in page 2

		const allTasks: ChildTaskLike[] = Array.from({ length: TOTAL_TASKS }, (_, i) =>
			task({
				id: `task-${i}`,
				status: i === IN_PROGRESS_TASK_INDEX ? 'in_progress' : 'todo',
				activeSessionId: i === IN_PROGRESS_TASK_INDEX ? 'session-1' : null,
			}),
		)

		const bet: BetLike = { id: 'bet-late', type: 'bet', status: 'active' }
		const rels: BreaksIntoRel[] = [{ sourceId: bet.id, targetId: `task-${IN_PROGRESS_TASK_INDEX}` }]

		const fetchPage = vi
			.fn<(params: { limit: number; offset: number }) => Promise<ChildTaskLike[]>>()
			.mockImplementation(async ({ limit, offset }) => allTasks.slice(offset, offset + limit))

		const paged = await fetchAllPages(fetchPage, PAGE_SIZE)

		expect(paged).toHaveLength(TOTAL_TASKS)
		expect(fetchPage).toHaveBeenCalledTimes(2)
		expect(paged.some((t) => t.id === `task-${IN_PROGRESS_TASK_INDEX}`)).toBe(true)

		const statuses = buildBetStatuses([bet], paged, rels, NOW)
		expect(statuses.get(bet.id)?.state).toBe('progressing')
	})

	it('classifies a bet as waiting_on_human when the open decision task is on a later page', async () => {
		const PAGE_SIZE = 50
		const TOTAL_TASKS = 120 // three pages: 50 + 50 + 20
		const DECISION_TASK_INDEX = 105

		const allTasks: ChildTaskLike[] = Array.from({ length: TOTAL_TASKS }, (_, i) =>
			task({
				id: `task-${i}`,
				status: 'todo',
				metadata: i === DECISION_TASK_INDEX ? { human_decision: true } : null,
			}),
		)

		const bet: BetLike = { id: 'bet-waiting', type: 'bet', status: 'active' }
		const rels: BreaksIntoRel[] = [{ sourceId: bet.id, targetId: `task-${DECISION_TASK_INDEX}` }]

		const fetchPage = vi
			.fn<(params: { limit: number; offset: number }) => Promise<ChildTaskLike[]>>()
			.mockImplementation(async ({ limit, offset }) => allTasks.slice(offset, offset + limit))

		const paged = await fetchAllPages(fetchPage, PAGE_SIZE)
		expect(fetchPage).toHaveBeenCalledTimes(3)

		const statuses = buildBetStatuses([bet], paged, rels, NOW)
		expect(statuses.get(bet.id)?.state).toBe('waiting_on_human')
	})

	it('classifies a bet as idle when a paged breaks_into edge points at a task not in the workspace list', () => {
		// Guards against the inverse: rels that reference targets outside the
		// task set (deleted task, non-task target) don't force a fallback path.
		const bet: BetLike = { id: 'bet-orphan', type: 'bet', status: 'active' }
		const rels: BreaksIntoRel[] = [{ sourceId: bet.id, targetId: 'task-does-not-exist' }]
		const statuses = buildBetStatuses([bet], [], rels, NOW)
		expect(statuses.get(bet.id)?.state).toBe('idle')
	})
})
