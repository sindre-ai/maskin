import { BoardView } from '@/components/objects/board/board-view'
import { deriveColumns } from '@/components/objects/board/derive-columns'
import { render, screen } from '@testing-library/react'
import { buildObjectResponse } from '../../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>agent working</span>,
}))

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
		// Status appears in column header AND on each card's StatusBadge — assert count >= 1.
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
		// Two columns × two skeletons each.
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
		expect(screen.getByText('Move a task here when work starts.')).toBeInTheDocument()
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
})
