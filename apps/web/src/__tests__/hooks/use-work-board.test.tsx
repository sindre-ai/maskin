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
		actors: {
			list: vi.fn(),
		},
	},
}))

vi.mock('@/lib/auth', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>
	return {
		...mod,
		getStoredActor: vi.fn(() => null),
	}
})

import { useWorkBoard } from '@/hooks/use-work-board'
import { api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { buildActorListItem, buildObjectResponse, buildRelationshipResponse } from '../factories'
import { createWorkspaceWrapper } from '../setup'

const workspaceId = 'ws-1'

function setupApi({
	bets = [] as ReturnType<typeof buildObjectResponse>[],
	tasks = [] as ReturnType<typeof buildObjectResponse>[],
	rels = [] as ReturnType<typeof buildRelationshipResponse>[],
	actors = [] as ReturnType<typeof buildActorListItem>[],
}) {
	vi.mocked(api.objects.list).mockImplementation(async (_ws: string, filters) => {
		if (filters?.type === 'bet') return bets
		if (filters?.type === 'task') return tasks
		return []
	})
	vi.mocked(api.relationships.list).mockResolvedValue(rels)
	vi.mocked(api.actors.list).mockResolvedValue(actors)
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

	it('uses workspace-configured task statuses as columns', async () => {
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
			'blocked',
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

	it('shows a task under every bet it is linked to', async () => {
		const betA = buildObjectResponse({ id: 'bet-a', type: 'bet', status: 'active', title: 'A' })
		const betB = buildObjectResponse({ id: 'bet-b', type: 'bet', status: 'active', title: 'B' })
		const shared = buildObjectResponse({ id: 't-shared', type: 'task', status: 'todo' })
		setupApi({
			bets: [betA, betB],
			tasks: [shared],
			rels: [
				buildRelationshipResponse({
					sourceId: 'bet-a',
					targetId: 't-shared',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
				buildRelationshipResponse({
					sourceId: 'bet-b',
					targetId: 't-shared',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
			],
		})

		const { result } = renderHook(() => useWorkBoard(), { wrapper: wrapper() })
		await waitFor(() => expect(result.current.isLoading).toBe(false))

		expect(result.current.board.swimlanes).toHaveLength(2)
		const laneA = result.current.board.swimlanes.find((l) => l.bet?.id === 'bet-a')
		const laneB = result.current.board.swimlanes.find((l) => l.bet?.id === 'bet-b')
		expect(laneA?.columns.todo.map((t) => t.id)).toEqual(['t-shared'])
		expect(laneB?.columns.todo.map((t) => t.id)).toEqual(['t-shared'])
	})

	it('filters by bet — only that swimlane survives', async () => {
		const betA = buildObjectResponse({ id: 'bet-a', type: 'bet', status: 'active', title: 'A' })
		const betB = buildObjectResponse({ id: 'bet-b', type: 'bet', status: 'active', title: 'B' })
		const tA = buildObjectResponse({ id: 't-a', type: 'task', status: 'todo' })
		const tB = buildObjectResponse({ id: 't-b', type: 'task', status: 'todo' })
		setupApi({
			bets: [betA, betB],
			tasks: [tA, tB],
			rels: [
				buildRelationshipResponse({
					sourceId: 'bet-a',
					targetId: 't-a',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
				buildRelationshipResponse({
					sourceId: 'bet-b',
					targetId: 't-b',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
			],
		})
		const { result } = renderHook(() => useWorkBoard({ filters: { bet: 'bet-a' } }), {
			wrapper: wrapper(),
		})
		await waitFor(() => expect(result.current.isLoading).toBe(false))
		expect(result.current.board.swimlanes).toHaveLength(1)
		expect(result.current.board.swimlanes[0].bet?.id).toBe('bet-a')
	})

	it('filters by status=blocked — keeps only blocked tasks; hides empty lanes', async () => {
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active' })
		const tBlocked = buildObjectResponse({ id: 't-b', type: 'task', status: 'blocked' })
		const tTodo = buildObjectResponse({ id: 't-t', type: 'task', status: 'todo' })
		const otherBet = buildObjectResponse({ id: 'bet-other', type: 'bet', status: 'active' })
		setupApi({
			bets: [bet, otherBet],
			tasks: [tBlocked, tTodo],
			rels: [
				buildRelationshipResponse({
					sourceId: 'bet-1',
					targetId: 't-b',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
				buildRelationshipResponse({
					sourceId: 'bet-1',
					targetId: 't-t',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
			],
		})
		const { result } = renderHook(() => useWorkBoard({ filters: { status: 'blocked' } }), {
			wrapper: wrapper(),
		})
		await waitFor(() => expect(result.current.isLoading).toBe(false))
		expect(result.current.board.swimlanes).toHaveLength(1)
		const lane = result.current.board.swimlanes[0]
		expect(lane.bet?.id).toBe('bet-1')
		expect(lane.columns.blocked.map((t) => t.id)).toEqual(['t-b'])
		expect(lane.columns.todo).toHaveLength(0)
	})

	it('filters by assignee=mine — uses the stored actor id', async () => {
		vi.mocked(getStoredActor).mockReturnValue({
			id: 'me',
			name: 'Me',
			type: 'human',
			email: null,
		})
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active' })
		const mine = buildObjectResponse({ id: 't-mine', type: 'task', status: 'todo', owner: 'me' })
		const someone = buildObjectResponse({
			id: 't-other',
			type: 'task',
			status: 'todo',
			owner: 'someone-else',
		})
		setupApi({
			bets: [bet],
			tasks: [mine, someone],
			rels: [
				buildRelationshipResponse({
					sourceId: 'bet-1',
					targetId: 't-mine',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
				buildRelationshipResponse({
					sourceId: 'bet-1',
					targetId: 't-other',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
			],
		})
		const { result } = renderHook(() => useWorkBoard({ filters: { assignee: 'mine' } }), {
			wrapper: wrapper(),
		})
		await waitFor(() => expect(result.current.isLoading).toBe(false))
		const tasksInLane = result.current.board.swimlanes[0].columns.todo
		expect(tasksInLane.map((t) => t.id)).toEqual(['t-mine'])
	})

	it('filters by assignee=agents — fetches actors and matches by type', async () => {
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active' })
		const agentTask = buildObjectResponse({
			id: 't-a',
			type: 'task',
			status: 'todo',
			owner: 'agent-1',
		})
		const humanTask = buildObjectResponse({
			id: 't-h',
			type: 'task',
			status: 'todo',
			owner: 'human-1',
		})
		setupApi({
			bets: [bet],
			tasks: [agentTask, humanTask],
			rels: [
				buildRelationshipResponse({
					sourceId: 'bet-1',
					targetId: 't-a',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
				buildRelationshipResponse({
					sourceId: 'bet-1',
					targetId: 't-h',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
			],
			actors: [
				buildActorListItem({ id: 'agent-1', type: 'agent' }),
				buildActorListItem({ id: 'human-1', type: 'human' }),
			],
		})
		const { result } = renderHook(() => useWorkBoard({ filters: { assignee: 'agents' } }), {
			wrapper: wrapper(),
		})
		await waitFor(() => expect(result.current.isLoading).toBe(false))
		await waitFor(() => {
			expect(result.current.board.swimlanes[0]?.columns.todo.map((t) => t.id)).toEqual(['t-a'])
		})
	})

	it('AND-combines multiple filters — bet + status', async () => {
		const betA = buildObjectResponse({ id: 'bet-a', type: 'bet', status: 'active' })
		const betB = buildObjectResponse({ id: 'bet-b', type: 'bet', status: 'active' })
		const tABlocked = buildObjectResponse({ id: 't-ab', type: 'task', status: 'blocked' })
		const tATodo = buildObjectResponse({ id: 't-at', type: 'task', status: 'todo' })
		const tBBlocked = buildObjectResponse({ id: 't-bb', type: 'task', status: 'blocked' })
		setupApi({
			bets: [betA, betB],
			tasks: [tABlocked, tATodo, tBBlocked],
			rels: [
				buildRelationshipResponse({
					sourceId: 'bet-a',
					targetId: 't-ab',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
				buildRelationshipResponse({
					sourceId: 'bet-a',
					targetId: 't-at',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
				buildRelationshipResponse({
					sourceId: 'bet-b',
					targetId: 't-bb',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
			],
		})
		const { result } = renderHook(
			() => useWorkBoard({ filters: { bet: 'bet-a', status: 'blocked' } }),
			{ wrapper: wrapper() },
		)
		await waitFor(() => expect(result.current.isLoading).toBe(false))
		expect(result.current.board.swimlanes).toHaveLength(1)
		expect(result.current.board.swimlanes[0].bet?.id).toBe('bet-a')
		expect(result.current.board.swimlanes[0].columns.blocked.map((t) => t.id)).toEqual(['t-ab'])
		expect(result.current.board.swimlanes[0].columns.todo).toHaveLength(0)
	})

	it('hides empty lanes when any filter is active', async () => {
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active' })
		const otherBet = buildObjectResponse({ id: 'bet-2', type: 'bet', status: 'active' })
		const blocked = buildObjectResponse({ id: 't-b', type: 'task', status: 'blocked' })
		setupApi({
			bets: [bet, otherBet],
			tasks: [blocked],
			rels: [
				buildRelationshipResponse({
					sourceId: 'bet-1',
					targetId: 't-b',
					type: 'breaks_into',
					sourceType: 'bet',
					targetType: 'task',
				}),
			],
		})
		// No filters: both lanes survive (empty `bet-2` is still visible).
		const { result: noFilters } = renderHook(() => useWorkBoard(), { wrapper: wrapper() })
		await waitFor(() => expect(noFilters.current.isLoading).toBe(false))
		expect(noFilters.current.board.swimlanes.map((l) => l.bet?.id)).toEqual(['bet-1', 'bet-2'])

		// With status filter, only the lane with matching tasks shows.
		const { result: withFilter } = renderHook(
			() => useWorkBoard({ filters: { status: 'blocked' } }),
			{ wrapper: wrapper() },
		)
		await waitFor(() => expect(withFilter.current.isLoading).toBe(false))
		expect(withFilter.current.board.swimlanes.map((l) => l.bet?.id)).toEqual(['bet-1'])
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
