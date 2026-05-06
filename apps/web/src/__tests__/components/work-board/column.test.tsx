import { Column } from '@/components/work-board/column'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildObjectResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigate,
}))

const wrapper = () => createWorkspaceWrapper({ id: 'ws-1' })

beforeEach(() => {
	navigate.mockClear()
})

describe('Column', () => {
	it('renders the column label and zero count when empty', () => {
		render(<Column status="todo" tasks={[]} laneId="bet-1" />, { wrapper: wrapper() })
		expect(screen.getByText('Todo')).toBeInTheDocument()
		expect(screen.getByText('0')).toBeInTheDocument()
		expect(screen.getByText(/no tasks in todo/i)).toBeInTheDocument()
	})

	it('renders one card per task with the task title', () => {
		const tasks = [
			buildObjectResponse({ id: 't-1', type: 'task', title: 'First' }),
			buildObjectResponse({ id: 't-2', type: 'task', title: 'Second' }),
		]
		render(<Column status="in_progress" tasks={tasks} laneId="bet-1" />, { wrapper: wrapper() })
		expect(screen.getByText('In progress')).toBeInTheDocument()
		expect(screen.getByText('First')).toBeInTheDocument()
		expect(screen.getByText('Second')).toBeInTheDocument()
		expect(screen.getByText('2')).toBeInTheDocument()
	})

	it('formats unknown statuses by replacing underscores and title-casing', () => {
		render(<Column status="some_custom_state" tasks={[]} laneId="bet-1" />, {
			wrapper: wrapper(),
		})
		expect(screen.getByText('Some Custom State')).toBeInTheDocument()
	})

	it('shows "Untitled task" when the task title is null', () => {
		const task = buildObjectResponse({ id: 't-1', type: 'task', title: null })
		render(<Column status="todo" tasks={[task]} laneId="bet-1" />, { wrapper: wrapper() })
		expect(screen.getByText('Untitled task')).toBeInTheDocument()
	})

	it('navigates to the task detail page when a card is clicked', () => {
		const task = buildObjectResponse({ id: 't-click', type: 'task', title: 'Click me' })
		render(<Column status="todo" tasks={[task]} laneId="bet-1" />, { wrapper: wrapper() })
		screen.getByText('Click me').click()

		expect(navigate).toHaveBeenCalledWith({
			to: '/$workspaceId/objects/$objectId',
			params: { workspaceId: 'ws-1', objectId: 't-click' },
		})
	})

	it('renders the soft WIP badge only when showWipBadge is true', () => {
		const tasks = [buildObjectResponse({ id: 't-1', type: 'task', title: 'r' })]
		const { rerender } = render(
			<Column status="in_review" tasks={tasks} laneId="bet-1" showWipBadge={false} />,
			{ wrapper: wrapper() },
		)
		expect(screen.queryByTestId('wip-badge')).not.toBeInTheDocument()

		rerender(<Column status="in_review" tasks={tasks} laneId="bet-1" showWipBadge={true} />)
		expect(screen.getByTestId('wip-badge')).toBeInTheDocument()
		expect(screen.getByText(/review queue is filling up/i)).toBeInTheDocument()
	})
})
