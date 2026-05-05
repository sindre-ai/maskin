import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		objects: {
			list: vi.fn(),
		},
		relationships: {
			list: vi.fn(),
		},
	},
}))

import { useWorkBoard } from '@/hooks/use-work-board'
import { api } from '@/lib/api'
import { buildObjectResponse, buildRelationshipResponse } from '../factories'
import { createWorkspaceWrapper } from '../setup'

const workspaceId = 'ws-1'

function setupApi({
	bets = [] as ReturnType<typeof buildObjectResponse>[],
	tasks = [] as ReturnType<typeof buildObjectResponse>[],
	rels = [] as ReturnType<typeof buildRelationshipResponse>[],
}) {
	vi.mocked(api.objects.list).mockImplementation(async (_ws: string, filters) => {
		if (filters?.type === 'bet') return bets
		if (filters?.type === 'task') return tasks
		return []
	})
	vi.mocked(api.relationships.list).mockResolvedValue(rels)
}

const wrapper = () =>
	createWorkspaceWrapper({
		id: workspaceId,
		settings: {
			statuses: {
				task: ['backlog', 'todo', 'in_progress', 'in_review', 'testing', 'done', 'blocked'],
			},
		},
	})

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useWorkBoard', () => {
	it('groups tasks under their parent bet via breaks_into relationships', async () => {
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active', title: 'Ship X' })
		const t1 = buildObjectResponse({ id: 't-1', type: 'task', status: 'todo', title: 'Spec' })
		const t2 = buildObjectResponse({
			id: 't-2',
			type: 'task',
			status: 'in_progress',
			title: 'Build',
		})
		const rel1 = buildRelationshipResponse({
			sourceType: 'bet',
			sourceId: 'bet-1',
			targetType: 'task',
			targetId: 't-1',
			type: 'breaks_into',
		})
		const rel2 = buildRelationshipResponse({
			sourceType: 'bet',
			sourceId: 'bet-1',
			targetType: 'task',
			targetId: 't-2',
			type: 'breaks_into',
		})
		setupApi({ bets: [bet], tasks: [t1, t2], rels: [rel1, rel2] })

		const { result } = renderHook(() => useWorkBoard(), { wrapper: wrapper() })
		await waitFor(() => expect(result.current.isLoading).toBe(false))

		expect(result.current.board.swimlanes).toHaveLength(1)
		const lane = result.current.board.swimlanes[0]
		expect(lane.bet?.id).toBe('bet-1')
		expect(lane.columns.todo).toHaveLength(1)
		expect(lane.columns.in_progress).toHaveLength(1)
		expect(lane.columns.todo[0].id).toBe('t-1')
	})

	it('places blocked tasks in the blocked band, not in a column', async () => {
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active' })
		const blockedTask = buildObjectResponse({ id: 't-b', type: 'task', status: 'blocked' })
		const rel = buildRelationshipResponse({
			sourceId: 'bet-1',
			targetId: 't-b',
			type: 'breaks_into',
			sourceType: 'bet',
			targetType: 'task',
		})
		setupApi({ bets: [bet], tasks: [blockedTask], rels: [rel] })

		const { result } = renderHook(() => useWorkBoard(), { wrapper: wrapper() })
		await waitFor(() => expect(result.current.isLoading).toBe(false))

		const lane = result.current.board.swimlanes[0]
		expect(lane.blocked).toHaveLength(1)
		expect(lane.blocked[0].id).toBe('t-b')
		expect(Object.values(lane.columns).every((col) => col.length === 0)).toBe(true)
	})

	it('puts orphan tasks in a "No bet" lane at the bottom', async () => {
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active' })
		const orphan = buildObjectResponse({ id: 't-o', type: 'task', status: 'todo' })
		const child = buildObjectResponse({ id: 't-c', type: 'task', status: 'todo' })
		const rel = buildRelationshipResponse({
			sourceId: 'bet-1',
			targetId: 't-c',
			type: 'breaks_into',
			sourceType: 'bet',
			targetType: 'task',
		})
		setupApi({ bets: [bet], tasks: [orphan, child], rels: [rel] })

		const { result } = renderHook(() => useWorkBoard(), { wrapper: wrapper() })
		await waitFor(() => expect(result.current.isLoading).toBe(false))

		expect(result.current.board.swimlanes).toHaveLength(2)
		const noBetLane = result.current.board.swimlanes[1]
		expect(noBetLane.bet).toBeNull()
		expect(noBetLane.columns.todo).toHaveLength(1)
		expect(noBetLane.columns.todo[0].id).toBe('t-o')
	})

	it('orders active bets before inactive ones', async () => {
		const inactive = buildObjectResponse({ id: 'bet-old', type: 'bet', status: 'completed' })
		const active = buildObjectResponse({ id: 'bet-new', type: 'bet', status: 'active' })
		const t1 = buildObjectResponse({ id: 't-1', type: 'task', status: 'todo' })
		const t2 = buildObjectResponse({ id: 't-2', type: 'task', status: 'done' })
		setupApi({
			bets: [inactive, active],
			tasks: [t1, t2],
			rels: [
				buildRelationshipResponse({
					sourceId: 'bet-new',
					targetId: 't-1',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
				buildRelationshipResponse({
					sourceId: 'bet-old',
					targetId: 't-2',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
			],
		})

		const { result } = renderHook(() => useWorkBoard(), { wrapper: wrapper() })
		await waitFor(() => expect(result.current.isLoading).toBe(false))

		expect(result.current.board.swimlanes.map((l) => l.bet?.id)).toEqual(['bet-new', 'bet-old'])
		expect(result.current.board.swimlanes[0].isActive).toBe(true)
		expect(result.current.board.swimlanes[1].isActive).toBe(false)
	})

	it('omits the no-bet lane when every task has a parent', async () => {
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active' })
		const task = buildObjectResponse({ id: 't-1', type: 'task', status: 'todo' })
		setupApi({
			bets: [bet],
			tasks: [task],
			rels: [
				buildRelationshipResponse({
					sourceId: 'bet-1',
					targetId: 't-1',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
			],
		})

		const { result } = renderHook(() => useWorkBoard(), { wrapper: wrapper() })
		await waitFor(() => expect(result.current.isLoading).toBe(false))

		expect(result.current.board.swimlanes).toHaveLength(1)
		expect(result.current.board.swimlanes[0].bet?.id).toBe('bet-1')
	})

	it('uses workspace-configured task statuses (minus blocked) as columns', async () => {
		setupApi({})

		const { result } = renderHook(() => useWorkBoard(), { wrapper: wrapper() })
		await waitFor(() => expect(result.current.isLoading).toBe(false))

		expect(result.current.board.columnStatuses).toEqual([
			'backlog',
			'todo',
			'in_progress',
			'in_review',
			'testing',
			'done',
		])
	})

	it('falls back to defaults when workspace settings have no task statuses', async () => {
		setupApi({})

		const wrap = createWorkspaceWrapper({ id: workspaceId, settings: {} })
		const { result } = renderHook(() => useWorkBoard(), { wrapper: wrap })
		await waitFor(() => expect(result.current.isLoading).toBe(false))

		expect(result.current.board.columnStatuses).toEqual([
			'backlog',
			'todo',
			'in_progress',
			'in_review',
			'testing',
			'done',
		])
	})

	it('groups tasks under their parent bet regardless of relationship type or direction', async () => {
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active' })
		const tInforms = buildObjectResponse({ id: 't-informs', type: 'task', status: 'todo' })
		const tReverse = buildObjectResponse({ id: 't-reverse', type: 'task', status: 'in_progress' })
		const tRelates = buildObjectResponse({ id: 't-relates', type: 'task', status: 'todo' })
		setupApi({
			bets: [bet],
			tasks: [tInforms, tReverse, tRelates],
			rels: [
				buildRelationshipResponse({
					sourceId: 'bet-1',
					targetId: 't-informs',
					type: 'informs',
					sourceType: 'bet',
					targetType: 'task',
				}),
				buildRelationshipResponse({
					sourceId: 't-reverse',
					targetId: 'bet-1',
					type: 'breaks_into',
					sourceType: 'task',
					targetType: 'bet',
				}),
				buildRelationshipResponse({
					sourceId: 'bet-1',
					targetId: 't-relates',
					type: 'relates_to',
					sourceType: 'bet',
					targetType: 'task',
				}),
			],
		})

		const { result } = renderHook(() => useWorkBoard(), { wrapper: wrapper() })
		await waitFor(() => expect(result.current.isLoading).toBe(false))

		expect(result.current.board.swimlanes).toHaveLength(1)
		const lane = result.current.board.swimlanes[0]
		expect(lane.bet?.id).toBe('bet-1')
		expect(lane.columns.todo.map((t) => t.id).sort()).toEqual(['t-informs', 't-relates'])
		expect(lane.columns.in_progress.map((t) => t.id)).toEqual(['t-reverse'])
	})

	it('drops a task whose status is not in the column list into the backlog column', async () => {
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active' })
		const ghostStatusTask = buildObjectResponse({
			id: 't-x',
			type: 'task',
			status: 'archived',
		})
		setupApi({
			bets: [bet],
			tasks: [ghostStatusTask],
			rels: [
				buildRelationshipResponse({
					sourceId: 'bet-1',
					targetId: 't-x',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
			],
		})

		const { result } = renderHook(() => useWorkBoard(), { wrapper: wrapper() })
		await waitFor(() => expect(result.current.isLoading).toBe(false))

		expect(result.current.board.swimlanes[0].columns.backlog).toHaveLength(1)
		expect(result.current.board.swimlanes[0].columns.backlog[0].id).toBe('t-x')
	})
})
