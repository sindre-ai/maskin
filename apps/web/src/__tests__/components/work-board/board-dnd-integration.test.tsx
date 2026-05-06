import { Board } from '@/components/work-board/board'
import type { ObjectResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { WorkspaceContext } from '@/lib/workspace-context'
import type { DragEndEvent } from '@dnd-kit/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildObjectResponse, buildWorkspaceWithRole } from '../../factories'

vi.mock('@/lib/api', () => ({
	api: {
		objects: { list: vi.fn(), update: vi.fn() },
		relationships: { list: vi.fn() },
	},
}))

vi.mock('sonner', () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}))

// Capture DndContext's handlers so the test can fire drag events without
// simulating real pointer movement (which dnd-kit's PointerSensor can't
// observe in jsdom without manual coordinate plumbing).
let capturedOnDragEnd: ((event: DragEndEvent) => void) | null = null
vi.mock('@dnd-kit/core', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	const DndContext = ({
		children,
		onDragEnd,
	}: {
		children: ReactNode
		onDragEnd?: (event: DragEndEvent) => void
	}) => {
		capturedOnDragEnd = onDragEnd ?? null
		return React.createElement(React.Fragment, null, children)
	}
	const DragOverlay = ({ children }: { children: ReactNode }) =>
		React.createElement(React.Fragment, null, children)
	return { ...actual, DndContext, DragOverlay }
})

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => () => {},
}))

const workspaceId = 'ws-1'

function setupApi(opts: { bets: ObjectResponse[]; tasks: ObjectResponse[] }) {
	vi.mocked(api.objects.list).mockImplementation(async (_ws: string, filters) => {
		if (filters?.type === 'bet') return opts.bets
		if (filters?.type === 'task') return opts.tasks
		return []
	})
	vi.mocked(api.relationships.list).mockResolvedValue([])
}

function makeWrapper(client: QueryClient) {
	const workspace = buildWorkspaceWithRole({
		id: workspaceId,
		settings: {
			statuses: {
				task: ['backlog', 'todo', 'in_progress', 'in_review', 'testing', 'done'],
			},
		},
	})
	return function Wrapper({ children }: { children: ReactNode }) {
		return React.createElement(
			QueryClientProvider,
			{ client },
			React.createElement(
				WorkspaceContext.Provider,
				{ value: { workspace, workspaceId, sseStatus: 'connected' } },
				children,
			),
		)
	}
}

function activeTask(task: ObjectResponse, laneId: string, status: string, index: number) {
	return {
		id: `task:${laneId}:${task.id}`,
		data: { current: { task, laneId, status, index, kind: 'task' } },
	} as unknown as DragEndEvent['active']
}

function overCard(task: ObjectResponse, laneId: string, status: string, index: number) {
	return {
		id: `taskdrop:${laneId}:${task.id}`,
		data: { current: { task, laneId, status, index, kind: 'card' } },
	} as unknown as DragEndEvent['over']
}

function overColumn(laneId: string, status: string) {
	return {
		id: `col:${laneId}:${status}`,
		data: { current: { laneId, status, kind: 'column' } },
	} as unknown as DragEndEvent['over']
}

beforeEach(() => {
	capturedOnDragEnd = null
	vi.clearAllMocks()
})

describe('Board drag-and-drop integration', () => {
	it('issues a status-change update when dropping a card on a different column', async () => {
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active', title: 'Bet 1' })
		const a = buildObjectResponse({
			id: 't-a',
			type: 'task',
			status: 'todo',
			title: 'A',
			metadata: { order: 100 },
		})
		setupApi({ bets: [bet], tasks: [a] })
		vi.mocked(api.objects.update).mockResolvedValue({ ...a, status: 'in_progress' })

		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
				mutations: { retry: false },
			},
		})
		render(React.createElement(Board), { wrapper: makeWrapper(client) })

		// Wait for the board to render and the onDragEnd to be wired up.
		await waitFor(() => expect(capturedOnDragEnd).not.toBeNull())

		capturedOnDragEnd?.({
			active: activeTask(a, 'bet-1', 'todo', 0),
			over: overColumn('bet-1', 'in_progress'),
		} as unknown as DragEndEvent)

		await waitFor(() => expect(api.objects.update).toHaveBeenCalledTimes(1))
		const [updatedId, updateBody] = vi.mocked(api.objects.update).mock.calls[0]
		expect(updatedId).toBe('t-a')
		const body = updateBody as { status?: string; metadata?: { order: number } }
		expect(body.status).toBe('in_progress')
		expect(typeof body.metadata?.order).toBe('number')
	})

	it('issues a metadata.order update (no status change) when reordering within a column', async () => {
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active' })
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
		setupApi({ bets: [bet], tasks: [a, b, c] })
		vi.mocked(api.objects.update).mockResolvedValue({ ...c, metadata: { order: 50 } })

		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
				mutations: { retry: false },
			},
		})
		render(React.createElement(Board), { wrapper: makeWrapper(client) })
		await waitFor(() => expect(capturedOnDragEnd).not.toBeNull())

		// Drop c onto a → c lands before a (one gap below 100).
		capturedOnDragEnd?.({
			active: activeTask(c, 'bet-1', 'todo', 2),
			over: overCard(a, 'bet-1', 'todo', 0),
		} as unknown as DragEndEvent)

		await waitFor(() => expect(api.objects.update).toHaveBeenCalledTimes(1))
		const [updatedId, updateBody] = vi.mocked(api.objects.update).mock.calls[0]
		expect(updatedId).toBe('t-c')
		expect((updateBody as { status?: string }).status).toBeUndefined()
		expect((updateBody as { metadata: { order: number } }).metadata.order).toBeLessThan(100)
	})

	it('rolls the optimistic cache patch back when the reorder request fails', async () => {
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active' })
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
		setupApi({ bets: [bet], tasks: [a, b] })
		vi.mocked(api.objects.update).mockRejectedValue(new Error('boom'))

		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
				mutations: { retry: false },
			},
		})
		render(React.createElement(Board), { wrapper: makeWrapper(client) })
		await waitFor(() => expect(capturedOnDragEnd).not.toBeNull())

		// Wait for the tasks list to be cached so the rollback test has something
		// to roll back from.
		await waitFor(() => {
			const tasks = client.getQueryData<ObjectResponse[]>(
				queryKeys.objects.list(workspaceId, { type: 'task' }),
			)
			expect(tasks?.length).toBe(2)
		})

		// Drop b on a → b's order should optimistically become < 100.
		capturedOnDragEnd?.({
			active: activeTask(b, 'bet-1', 'todo', 1),
			over: overCard(a, 'bet-1', 'todo', 0),
		} as unknown as DragEndEvent)

		// After the rejection settles, the cached task's order is back to 200.
		await waitFor(() => expect(api.objects.update).toHaveBeenCalledTimes(1))
		await waitFor(() => {
			const tasks = client.getQueryData<ObjectResponse[]>(
				queryKeys.objects.list(workspaceId, { type: 'task' }),
			)
			const cachedB = tasks?.find((t) => t.id === 't-b')
			expect((cachedB?.metadata as { order?: number } | null)?.order).toBe(200)
		})
	})
})
