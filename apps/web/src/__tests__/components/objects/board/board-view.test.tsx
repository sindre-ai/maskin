import { BoardView } from '@/components/objects/board/board-view'
import { deriveColumns } from '@/components/objects/board/derive-columns'
import { act, render, screen, waitFor } from '@testing-library/react'
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
let capturedDragStart: ((event: unknown) => void) | null = null
let capturedDragOver: ((event: unknown) => void) | null = null
vi.mock('@dnd-kit/core', () => ({
	DndContext: ({
		onDragEnd,
		onDragStart,
		onDragOver,
		onDragCancel,
		children,
	}: {
		onDragEnd?: (event: unknown) => void
		onDragStart?: (event: unknown) => void
		onDragOver?: (event: unknown) => void
		onDragCancel?: () => void
		children: React.ReactNode
	}) => {
		capturedDragEnd = onDragEnd ?? null
		capturedDragStart = onDragStart ?? null
		capturedDragOver = onDragOver ?? null
		void onDragStart
		void onDragOver
		void onDragCancel
		return <div data-testid="dnd-context">{children}</div>
	},
	DragOverlay: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="drag-overlay">{children}</div>
	),
	PointerSensor: function PointerSensor() {},
	closestCenter: vi.fn(),
	pointerWithin: vi.fn(() => []),
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

vi.mock('@dnd-kit/sortable', () => ({
	SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	verticalListSortingStrategy: {},
	useSortable: () => ({
		attributes: {},
		listeners: {},
		setNodeRef: () => {},
		transform: null,
		transition: undefined,
		isDragging: false,
	}),
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
	capturedDragStart = null
	capturedDragOver = null
})

function makeDragEvent(activeObject: unknown, overStatus: string | null) {
	return {
		active: { id: 'a', data: { current: { object: activeObject } } },
		over: overStatus
			? { id: `col:${overStatus}`, data: { current: { status: overStatus } } }
			: null,
	}
}

function makeCardDragEvent(
	activeObject: { id?: string } | unknown,
	overObject: { id?: string } | unknown,
	overStatus: string,
	placement: 'before' | 'after' = 'before',
	options: { activeTop?: number; pointerStartY?: number; pointerDeltaY?: number } = {},
) {
	const overId =
		overObject && typeof overObject === 'object' && 'id' in overObject
			? String(overObject.id)
			: 'card-over'
	const overTop = 100
	const overHeight = 80
	const activeTop = options.activeTop ?? (placement === 'after' ? 150 : 90)
	return {
		active: {
			id:
				activeObject && typeof activeObject === 'object' && 'id' in activeObject
					? String(activeObject.id)
					: 'a',
			data: { current: { object: activeObject } },
			rect: {
				current: {
					initial: { top: activeTop, height: 40 },
					translated: { top: activeTop, height: 40 },
				},
			},
		},
		over: {
			id: overId,
			data: { current: { object: overObject, status: overStatus } },
			rect: { top: overTop, height: overHeight },
		},
		activatorEvent:
			options.pointerStartY !== undefined
				? new MouseEvent('pointerdown', { clientY: options.pointerStartY })
				: undefined,
		delta: { x: 0, y: options.pointerDeltaY ?? 0 },
	}
}

function fireDragEnd(event: unknown) {
	act(() => {
		capturedDragEnd?.(event)
	})
}

function fireDragStart(event: unknown) {
	act(() => {
		capturedDragStart?.(event)
	})
}

function fireDragOver(event: unknown) {
	act(() => {
		capturedDragOver?.(event)
	})
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

	it('renders an insertion preview for cross-column drags', () => {
		const source = buildObjectResponse({ id: 'source', type: 'task', status: 'in_progress' })
		const todoA = buildObjectResponse({ id: 'todo-a', type: 'task', status: 'todo', title: 'A' })
		const todoB = buildObjectResponse({ id: 'todo-b', type: 'task', status: 'todo', title: 'B' })
		render(
			<BoardView
				objectType="task"
				workspaceId="ws-1"
				statusesByType={{ task: ['todo', 'in_progress'] }}
				objects={[todoA, todoB, source]}
			/>,
		)

		fireDragStart({ active: { id: source.id, data: { current: { object: source } } } })
		fireDragOver(makeCardDragEvent(source, todoB, 'todo', 'before'))

		expect(screen.getByTestId('board-drop-preview')).toBeInTheDocument()
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

	it('orders cards by metadata.board_order within a column', () => {
		render(
			<BoardView
				objectType="task"
				workspaceId="ws-1"
				statusesByType={{ task: ['todo'] }}
				objects={[
					buildObjectResponse({
						id: 'b',
						type: 'task',
						status: 'todo',
						title: 'Second',
						metadata: { board_order: 20 },
					}),
					buildObjectResponse({
						id: 'a',
						type: 'task',
						status: 'todo',
						title: 'First',
						metadata: { board_order: 10 },
					}),
				]}
			/>,
		)
		const cards = screen.getAllByTestId('board-card')
		expect(cards[0]).toHaveTextContent('First')
		expect(cards[1]).toHaveTextContent('Second')
	})

	it('keeps ranked cards in position relative to unranked cards', () => {
		render(
			<BoardView
				objectType="task"
				workspaceId="ws-1"
				statusesByType={{ task: ['todo'] }}
				objects={[
					buildObjectResponse({
						id: 'a',
						type: 'task',
						status: 'todo',
						title: 'First',
						createdAt: '2026-06-03T13:00:00.000Z',
					}),
					buildObjectResponse({
						id: 'b',
						type: 'task',
						status: 'todo',
						title: 'Second',
						createdAt: '2026-06-03T13:01:00.000Z',
					}),
					buildObjectResponse({
						id: 'c',
						type: 'task',
						status: 'todo',
						title: 'Inserted between second and third',
						createdAt: '2026-06-03T13:10:00.000Z',
						metadata: { board_order: 1.5 },
					}),
					buildObjectResponse({
						id: 'd',
						type: 'task',
						status: 'todo',
						title: 'Third',
						createdAt: '2026-06-03T13:02:00.000Z',
					}),
				]}
			/>,
		)
		const cards = screen.getAllByTestId('board-card')
		expect(cards.map((card) => card.textContent)).toEqual([
			expect.stringContaining('First'),
			expect.stringContaining('Second'),
			expect.stringContaining('Inserted between second and third'),
			expect.stringContaining('Third'),
		])
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

			fireDragEnd(makeDragEvent(obj, 'in_progress'))

			expect(bulkUpdateMutate).toHaveBeenCalledTimes(1)
			expect(bulkUpdateMutate).toHaveBeenCalledWith(
				{
					ids: ['t1'],
					patch: {
						status: 'in_progress',
						metadata: expect.objectContaining({ board_order: expect.any(Number) }),
					},
				},
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
			fireDragEnd(makeDragEvent(obj, 'done'))

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
			fireDragEnd(makeDragEvent(obj, 'todo'))
			expect(bulkUpdateMutate).not.toHaveBeenCalled()
		})

		it('reorders within the same column when dropped on a different card', () => {
			const objA = buildObjectResponse({
				id: 'a',
				type: 'task',
				status: 'todo',
				metadata: { board_order: 10 },
			})
			const objB = buildObjectResponse({
				id: 'b',
				type: 'task',
				status: 'todo',
				metadata: { board_order: 20 },
			})
			render(
				<BoardView
					objectType="task"
					workspaceId="ws-1"
					statusesByType={{ task: ['todo'] }}
					objects={[objA, objB]}
				/>,
			)
			fireDragEnd(makeCardDragEvent(objB, objA, 'todo'))
			expect(bulkUpdateMutate).toHaveBeenCalledTimes(1)
			expect(bulkUpdateMutate).toHaveBeenCalledWith(
				{
					ids: ['b'],
					patch: expect.objectContaining({
						metadata: expect.objectContaining({ board_order: expect.any(Number) }),
					}),
				},
				expect.objectContaining({ onError: expect.any(Function) }),
			)
		})

		it('moves the top card into the third position when cards have no saved board order', () => {
			const objA = buildObjectResponse({ id: 'a', type: 'task', status: 'todo' })
			const objB = buildObjectResponse({ id: 'b', type: 'task', status: 'todo' })
			const objC = buildObjectResponse({ id: 'c', type: 'task', status: 'todo' })
			render(
				<BoardView
					objectType="task"
					workspaceId="ws-1"
					statusesByType={{ task: ['todo'] }}
					objects={[objA, objB, objC]}
				/>,
			)
			fireDragEnd(makeCardDragEvent(objA, objC, 'todo', 'after'))
			expect(bulkUpdateMutate).toHaveBeenCalledWith(
				{
					ids: ['a'],
					patch: expect.objectContaining({
						metadata: expect.objectContaining({ board_order: 2 }),
					}),
				},
				expect.objectContaining({ onError: expect.any(Function) }),
			)
		})

		it('uses pointer position rather than dragged card center to choose before or after', () => {
			const objA = buildObjectResponse({ id: 'a', type: 'task', status: 'todo' })
			const objB = buildObjectResponse({ id: 'b', type: 'task', status: 'todo' })
			const objC = buildObjectResponse({ id: 'c', type: 'task', status: 'todo' })
			render(
				<BoardView
					objectType="task"
					workspaceId="ws-1"
					statusesByType={{ task: ['todo'] }}
					objects={[objA, objB, objC]}
				/>,
			)
			fireDragEnd(
				makeCardDragEvent(objC, objB, 'todo', 'after', {
					activeTop: 150,
					pointerStartY: 150,
					pointerDeltaY: -40,
				}),
			)
			expect(bulkUpdateMutate).toHaveBeenCalledWith(
				{
					ids: ['c'],
					patch: expect.objectContaining({
						metadata: expect.objectContaining({ board_order: 0.5 }),
					}),
				},
				expect.objectContaining({ onError: expect.any(Function) }),
			)
		})

		it('moves a card from another column into a middle position without saved board orders', () => {
			const todoA = buildObjectResponse({ id: 'todo-a', type: 'task', status: 'todo' })
			const todoB = buildObjectResponse({ id: 'todo-b', type: 'task', status: 'todo' })
			const todoC = buildObjectResponse({ id: 'todo-c', type: 'task', status: 'todo' })
			const progress = buildObjectResponse({
				id: 'progress-a',
				type: 'task',
				status: 'in_progress',
			})
			render(
				<BoardView
					objectType="task"
					workspaceId="ws-1"
					statusesByType={{ task: ['todo', 'in_progress'] }}
					objects={[todoA, todoB, todoC, progress]}
				/>,
			)
			fireDragEnd(makeCardDragEvent(progress, todoB, 'todo', 'before'))
			expect(bulkUpdateMutate).toHaveBeenCalledWith(
				{
					ids: ['progress-a'],
					patch: expect.objectContaining({
						status: 'todo',
						metadata: expect.objectContaining({ board_order: 0.5 }),
					}),
				},
				expect.objectContaining({ onError: expect.any(Function) }),
			)
		})

		it('moves across columns into a specific spot when dropped on a card', () => {
			const obj = buildObjectResponse({ id: 'a', type: 'task', status: 'todo' })
			const target = buildObjectResponse({
				id: 'b',
				type: 'task',
				status: 'done',
				metadata: { board_order: 10 },
			})
			render(
				<BoardView
					objectType="task"
					workspaceId="ws-1"
					statusesByType={{ task: ['todo', 'done'] }}
					objects={[obj, target]}
				/>,
			)
			fireDragEnd(makeCardDragEvent(obj, target, 'done'))
			expect(bulkUpdateMutate).toHaveBeenCalledTimes(1)
			expect(bulkUpdateMutate).toHaveBeenCalledWith(
				{
					ids: ['a'],
					patch: expect.objectContaining({
						status: 'done',
						metadata: expect.objectContaining({ board_order: expect.any(Number) }),
					}),
				},
				expect.objectContaining({ onError: expect.any(Function) }),
			)
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
			fireDragEnd(makeDragEvent(obj, null))
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
			fireDragEnd(makeDragEvent(bet, 'active'))
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
