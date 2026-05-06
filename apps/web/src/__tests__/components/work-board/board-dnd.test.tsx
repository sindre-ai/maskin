import { resolveDragOutcome } from '@/components/work-board/board'
import type { BoardSwimlane, WorkBoardModel } from '@/hooks/use-work-board'
import type { ObjectResponse } from '@/lib/api'
import { TASK_ORDER_GAP } from '@/lib/task-order'
import type { DragEndEvent } from '@dnd-kit/core'
import { describe, expect, it } from 'vitest'
import { buildObjectResponse } from '../../factories'

function makeColumns(
	statuses: string[],
	bucket: Record<string, ObjectResponse[]> = {},
): Record<string, ObjectResponse[]> {
	const cols: Record<string, ObjectResponse[]> = {}
	for (const status of statuses) cols[status] = bucket[status] ?? []
	return cols
}

function makeBoard(lane: BoardSwimlane): WorkBoardModel {
	return {
		swimlanes: [lane],
		columnStatuses: ['backlog', 'todo', 'in_progress', 'in_review', 'testing', 'done'],
		totalTasks: Object.values(lane.columns).reduce((s, c) => s + c.length, 0),
	}
}

function activeStub(task: ObjectResponse, laneId: string, status: string, index: number) {
	return {
		id: `task:${laneId}:${task.id}`,
		data: { current: { task, laneId, status, index, kind: 'task' as const } },
	} as unknown as DragEndEvent['active']
}

function overColumn(laneId: string, status: string) {
	return {
		id: `col:${laneId}:${status}`,
		data: { current: { laneId, status, kind: 'column' as const } },
	} as unknown as DragEndEvent['over']
}

function overCard(task: ObjectResponse, laneId: string, status: string, index: number) {
	return {
		id: `taskdrop:${laneId}:${task.id}`,
		data: { current: { task, laneId, status, index, kind: 'card' as const } },
	} as unknown as DragEndEvent['over']
}

describe('resolveDragOutcome', () => {
	const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active', title: 'Bet 1' })

	it('returns a status change patch when dropping on a different column', () => {
		const movingTask = buildObjectResponse({
			id: 't-move',
			type: 'task',
			status: 'todo',
			title: 'Move me',
			metadata: { order: 100, customFlag: true },
		})
		const lane: BoardSwimlane = {
			bet,
			isActive: true,
			columns: makeColumns(['todo', 'in_progress'], { todo: [movingTask], in_progress: [] }),
		}
		const board = makeBoard(lane)

		const outcome = resolveDragOutcome(
			activeStub(movingTask, 'bet-1', 'todo', 0),
			overColumn('bet-1', 'in_progress'),
			board,
		)

		expect(outcome).not.toBeNull()
		expect(outcome?.taskId).toBe('t-move')
		expect(outcome?.data.status).toBe('in_progress')
		expect(outcome?.data.metadata).toEqual({ order: expect.any(Number), customFlag: true })
	})

	it('returns a reorder-only patch when dropping on a card in the same column', () => {
		const a = buildObjectResponse({
			id: 't-a',
			type: 'task',
			status: 'todo',
			metadata: { order: 100 },
		})
		const b = buildObjectResponse({
			id: 't-b',
			type: 'task',
			status: 'todo',
			metadata: { order: 200 },
		})
		const c = buildObjectResponse({
			id: 't-c',
			type: 'task',
			status: 'todo',
			metadata: { order: 300 },
		})
		const lane: BoardSwimlane = {
			bet,
			isActive: true,
			columns: makeColumns(['todo'], { todo: [a, b, c] }),
		}
		const board = makeBoard(lane)

		// Drag c (last) onto a (first) → c lands before a. Expected order: a's
		// existing order minus a gap.
		const outcome = resolveDragOutcome(
			activeStub(c, 'bet-1', 'todo', 2),
			overCard(a, 'bet-1', 'todo', 0),
			board,
		)

		expect(outcome).not.toBeNull()
		expect(outcome?.taskId).toBe('t-c')
		expect(outcome?.data.status).toBeUndefined()
		expect(outcome?.data.metadata.order).toBe(100 - TASK_ORDER_GAP)
	})

	it('returns null when dropping a card on itself', () => {
		const a = buildObjectResponse({
			id: 't-a',
			type: 'task',
			status: 'todo',
			metadata: { order: 100 },
		})
		const lane: BoardSwimlane = {
			bet,
			isActive: true,
			columns: makeColumns(['todo'], { todo: [a] }),
		}
		const board = makeBoard(lane)

		const outcome = resolveDragOutcome(
			activeStub(a, 'bet-1', 'todo', 0),
			overCard(a, 'bet-1', 'todo', 0),
			board,
		)
		expect(outcome).toBeNull()
	})

	it('returns null for a cross-bet drag', () => {
		const movingTask = buildObjectResponse({
			id: 't-move',
			type: 'task',
			status: 'todo',
		})
		const lane: BoardSwimlane = {
			bet,
			isActive: true,
			columns: makeColumns(['todo'], { todo: [movingTask] }),
		}
		const board = makeBoard(lane)

		const outcome = resolveDragOutcome(
			activeStub(movingTask, 'bet-1', 'todo', 0),
			overColumn('different-bet', 'todo'),
			board,
		)
		expect(outcome).toBeNull()
	})

	it('returns null when dropped outside any droppable', () => {
		const t = buildObjectResponse({ id: 't-1', type: 'task', status: 'todo' })
		const board = makeBoard({
			bet,
			isActive: true,
			columns: makeColumns(['todo'], { todo: [t] }),
		})
		expect(resolveDragOutcome(activeStub(t, 'bet-1', 'todo', 0), null, board)).toBeNull()
	})

	it('places the moved card at the end when dropping on the column body', () => {
		const a = buildObjectResponse({
			id: 'a',
			type: 'task',
			status: 'todo',
			metadata: { order: 100 },
		})
		const b = buildObjectResponse({
			id: 'b',
			type: 'task',
			status: 'in_progress',
			metadata: { order: 200 },
		})
		const lane: BoardSwimlane = {
			bet,
			isActive: true,
			columns: makeColumns(['todo', 'in_progress'], { todo: [a], in_progress: [b] }),
		}
		const outcome = resolveDragOutcome(
			activeStub(a, 'bet-1', 'todo', 0),
			overColumn('bet-1', 'in_progress'),
			makeBoard(lane),
		)
		// a moved to end of in_progress; only b is there → a's new order = b + GAP
		expect(outcome?.data.status).toBe('in_progress')
		expect(outcome?.data.metadata.order).toBe(200 + TASK_ORDER_GAP)
	})

	it('returns null when the drop changes neither status nor order', () => {
		// A solo card in its column dropped on the same column body. Re-derived
		// order matches the existing one, status doesn't change → no-op.
		const solo = buildObjectResponse({
			id: 'solo',
			type: 'task',
			status: 'todo',
			metadata: { order: 1024 },
		})
		const lane: BoardSwimlane = {
			bet,
			isActive: true,
			columns: makeColumns(['todo'], { todo: [solo] }),
		}
		const outcome = resolveDragOutcome(
			activeStub(solo, 'bet-1', 'todo', 0),
			overColumn('bet-1', 'todo'),
			makeBoard(lane),
		)
		expect(outcome).toBeNull()
	})
})
