import { BoardView } from '@/components/objects/board/board-view'
import { deriveColumns } from '@/components/objects/board/derive-columns'
import { render, screen, waitFor } from '@testing-library/react'
import { buildObjectResponse } from '../../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>agent working</span>,
}))

// dnd-kit pulls in pointer-capture APIs jsdom doesn't ship, and we want to
// drive `onDragEnd` directly from the tests. Capture the handler off the
// `DndContext` props and stub the draggable/droppable hooks to no-ops so the
// tree renders.
let capturedDragEnd: ((event: unknown) => void) | null = null
vi.mock('@dnd-kit/core', () => ({
	DndContext: ({
		onDragEnd,
		onDragStart,
		onDragCancel,
		children,
	}: {
		onDragEnd?: (event: unknown) => void
		onDragStart?: (event: unknown) => void
		onDragCancel?: () => void
		children: React.ReactNode
	}) => {
		capturedDragEnd = onDragEnd ?? null
		void onDragStart
		void onDragCancel
		return <div data-testid="dnd-context">{children}</div>
	},
	DragOverlay: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="drag-overlay">{children}</div>
	),
	PointerSensor: function PointerSensor() {},
	useSensor: () => undefined,
	useSensors: () => [],
	useDraggable: () => ({
		attributes: {},
		listeners: {},
		setNodeRef: () => {},
		isDragging: false,
	}),
	useDroppable: () => ({ setNodeRef: () => {}, isOver: false, active: null }),
}))

const bulkUpdateMutate = vi.fn()
vi.mock('@/hooks/use-objects', () => ({
	useBulkUpdateObjects: () => ({ mutate: bulkUpdateMutate }),
}))

const toastError = vi.fn()
vi.mock('sonner', () => ({
	toast: { error: (msg: string) => toastError(msg) },
}))

beforeEach(() => {
	bulkUpdateMutate.mockReset()
	toastError.mockReset()
	capturedDragEnd = null
})

function makeDragEvent(activeObject: unknown, overStatus: string | null) {
	return {
		active: { id: 'a', data: { current: { object: activeObject } } },
		over: overStatus
			? { id: `col:${overStatus}`, data: { current: { status: overStatus } } }
			: null,
	}
}

describe('deriveColumns', () => {
	it('returns one column per configured status, in order', () => {
		const objects = [
			buildObjectResponse({ id: 'a', type: 'task', status: 'todo', title: 'A' }),
			buildObjectResponse({ id: 'b', type: 'task', status: 'in_progress', title: 'B' }),
			buildObjectResponse({ id: 'c', type: 'task', status: 'in_progress', title: 'C' }),
			buildObjectResponse({ id: 'd', type: 'task', status: 'done', title: 'D' }),
		]
		const columns = deriveColumns('task', { task: ['todo', 'in_progress', 'done'] }, objects)
		expect(columns.map((c) => c.status)).toEqual(['todo', 'in_progress', 'done'])
		expect(columns[0].objects.map((o) => o.id)).toEqual(['a'])
		expect(columns[1].objects.map((o) => o.id)).toEqual(['b', 'c'])
		expect(columns[2].objects.map((o) => o.id)).toEqual(['d'])
	})

	it('drops objects whose type does not match the active type', () => {
		const objects = [
			buildObjectResponse({ id: 'a', type: 'task', status: 'todo' }),
			buildObjectResponse({ id: 'b', type: 'insight', status: 'todo' }),
		]
		const columns = deriveColumns('task', { task: ['todo'] }, objects)
		expect(columns[0].objects.map((o) => o.id)).toEqual(['a'])
	})

	it('drops objects whose status is not in the configured list', () => {
		const objects = [
			buildObjectResponse({ id: 'a', type: 'task', status: 'todo' }),
			buildObjectResponse({ id: 'b', type: 'task', status: 'archived' }),
		]
		const columns = deriveColumns('task', { task: ['todo'] }, objects)
		expect(columns).toHaveLength(1)
		expect(columns[0].objects.map((o) => o.id)).toEqual(['a'])
	})

	it('returns an empty array when the active type has no configured statuses', () => {
		const columns = deriveColumns('task', { insight: ['new'] }, [])
		expect(columns).toEqual([])
	})

	it('returns an empty array when the configured statuses are an empty list', () => {
		const columns = deriveColumns('task', { task: [] }, [])
		expect(columns).toEqual([])
	})
})

describe('BoardView', () => {
	it('renders one column per configured status with status header + count', () => {
		render(
			<BoardView
				objectType="task"
				workspaceId="ws-1"
				statusesByType={{ task: ['todo', 'in_progress', 'done'] }}
				objects={[
					buildObjectResponse({ id: 'a', type: 'task', status: 'todo', title: 'Alpha' }),
					buildObjectResponse({ id: 'b', type: 'task', status: 'todo', title: 'Bravo' }),
					buildObjectResponse({ id: 'c', type: 'task', status: 'done', title: 'Charlie' }),
				]}
			/>,
		)
		expect(screen.getAllByText('todo').length).toBeGreaterThanOrEqual(1)
		expect(screen.getAllByText('in progress').length).toBeGreaterThanOrEqual(1)
		expect(screen.getAllByText('done').length).toBeGreaterThanOrEqual(1)
		expect(screen.getByText('Alpha')).toBeInTheDocument()
		expect(screen.getByText('Bravo')).toBeInTheDocument()
		expect(screen.getByText('Charlie')).toBeInTheDocument()
	})

	it('renders the empty-state message when the active type has no configured statuses', () => {
		render(
			<BoardView
				objectType="task"
				workspaceId="ws-1"
				statusesByType={{ insight: ['new'] }}
				objects={[]}
			/>,
		)
		expect(screen.getByText('No statuses configured')).toBeInTheDocument()
		expect(screen.queryByTestId('board-view')).not.toBeInTheDocument()
	})

	it('renders skeleton placeholders for every column while loading', () => {
		render(
			<BoardView
				objectType="task"
				workspaceId="ws-1"
				statusesByType={{ task: ['todo', 'in_progress'] }}
				objects={[]}
				isLoading
			/>,
		)
		expect(screen.getAllByTestId('board-card-skeleton')).toHaveLength(4)
	})

	it('shows the per-column empty hint when a column has no objects and is not loading', () => {
		render(
			<BoardView
				objectType="task"
				workspaceId="ws-1"
				statusesByType={{ task: ['todo'] }}
				objects={[]}
			/>,
		)
		expect(screen.getByText('Nothing here yet.')).toBeInTheDocument()
		expect(screen.getByText('Drag a card to todo.')).toBeInTheDocument()
	})

	it('uses the active status name in the empty hint', () => {
		render(
			<BoardView
				objectType="insight"
				workspaceId="ws-1"
				statusesByType={{ insight: ['under_review'] }}
				objects={[]}
			/>,
		)
		expect(screen.getByText('Drag a card to under review.')).toBeInTheDocument()
	})

	it('renders the drop cue below existing cards when a column is a valid target', () => {
		render(
			<BoardView
				objectType="task"
				workspaceId="ws-1"
				statusesByType={{ task: ['todo', 'done'] }}
				objects={[
					buildObjectResponse({ id: 'a', type: 'task', status: 'done', title: 'Done one' }),
				]}
			/>,
		)
		expect(screen.queryByText('Drop here to move to todo.')).not.toBeInTheDocument()
	})

	it('renders a BoardCard for each object in the column', () => {
		render(
			<BoardView
				objectType="task"
				workspaceId="ws-1"
				statusesByType={{ task: ['todo'] }}
				objects={[
					buildObjectResponse({ id: 'a', type: 'task', status: 'todo', title: 'Alpha' }),
					buildObjectResponse({ id: 'b', type: 'task', status: 'todo', title: 'Bravo' }),
				]}
			/>,
		)
		expect(screen.getAllByTestId('board-card')).toHaveLength(2)
	})

	describe('drag-to-status', () => {
		it('calls the bulk-update mutation with the dropped status when a task is dragged to a new column', () => {
			const obj = buildObjectResponse({ id: 't1', type: 'task', status: 'todo' })
			render(
				<BoardView
					objectType="task"
					workspaceId="ws-1"
					statusesByType={{ task: ['todo', 'in_progress', 'done'] }}
					objects={[obj]}
				/>,
			)
			expect(capturedDragEnd).toBeTypeOf('function')

			capturedDragEnd?.(makeDragEvent(obj, 'in_progress'))

			expect(bulkUpdateMutate).toHaveBeenCalledTimes(1)
			expect(bulkUpdateMutate).toHaveBeenCalledWith(
				{ ids: ['t1'], patch: { status: 'in_progress' } },
				expect.objectContaining({ onError: expect.any(Function) }),
			)
		})

		it('surfaces a toast when the mutation rejects (rollback is owned by useBulkUpdateObjects)', async () => {
			const obj = buildObjectResponse({ id: 't1', type: 'task', status: 'todo' })
			// Simulate the mutation calling onError synchronously with a real Error.
			bulkUpdateMutate.mockImplementation(
				(_input: unknown, opts: { onError?: (e: Error) => void }) => {
					opts.onError?.(new Error('Network blew up'))
				},
			)

			render(
				<BoardView
					objectType="task"
					workspaceId="ws-1"
					statusesByType={{ task: ['todo', 'done'] }}
					objects={[obj]}
				/>,
			)
			capturedDragEnd?.(makeDragEvent(obj, 'done'))

			await waitFor(() => {
				expect(toastError).toHaveBeenCalledWith('Network blew up')
			})
		})

		it('does not mutate when dropping on the same column the card already lives in', () => {
			const obj = buildObjectResponse({ id: 't1', type: 'task', status: 'todo' })
			render(
				<BoardView
					objectType="task"
					workspaceId="ws-1"
					statusesByType={{ task: ['todo', 'done'] }}
					objects={[obj]}
				/>,
			)
			capturedDragEnd?.(makeDragEvent(obj, 'todo'))
			expect(bulkUpdateMutate).not.toHaveBeenCalled()
		})

		it('does not mutate when the drop happens outside any droppable column', () => {
			const obj = buildObjectResponse({ id: 't1', type: 'task', status: 'todo' })
			render(
				<BoardView
					objectType="task"
					workspaceId="ws-1"
					statusesByType={{ task: ['todo', 'done'] }}
					objects={[obj]}
				/>,
			)
			capturedDragEnd?.(makeDragEvent(obj, null))
			expect(bulkUpdateMutate).not.toHaveBeenCalled()
		})

		it('moves bet cards like any other object type', () => {
			const bet = buildObjectResponse({ id: 'b1', type: 'bet', status: 'proposed' })
			render(
				<BoardView
					objectType="bet"
					workspaceId="ws-1"
					statusesByType={{ bet: ['proposed', 'active'] }}
					objects={[bet]}
				/>,
			)
			capturedDragEnd?.(makeDragEvent(bet, 'active'))
			expect(bulkUpdateMutate).toHaveBeenCalledTimes(1)
		})
	})

	describe('draggable cards', () => {
		it('renders bet cards with the draggable wrapper', () => {
			render(
				<BoardView
					objectType="bet"
					workspaceId="ws-1"
					statusesByType={{ bet: ['proposed', 'active'] }}
					objects={[
						buildObjectResponse({ id: 'b1', type: 'bet', status: 'active', title: 'Big bet' }),
					]}
				/>,
			)
			expect(screen.getByText('Big bet')).toBeInTheDocument()
			expect(screen.getByTestId('board-card-draggable')).toBeInTheDocument()
		})

		it('does not render a gated helper banner', () => {
			render(
				<BoardView
					objectType="bet"
					workspaceId="ws-1"
					statusesByType={{ bet: ['proposed', 'active'] }}
					objects={[buildObjectResponse({ id: 'b1', type: 'bet', status: 'active' })]}
				/>,
			)
			expect(screen.queryByTestId('board-bets-gated-banner')).not.toBeInTheDocument()
		})
	})
})
