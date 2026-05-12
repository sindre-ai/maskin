import { TasksBoard } from '@/components/tasks/tasks-board'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const mockNavigate = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return {
		...mockTanStackRouter(),
		useNavigate: () => mockNavigate,
	}
})

describe('TasksBoard', () => {
	const wrapper = createWorkspaceWrapper()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders empty state when no tasks', () => {
		render(<TasksBoard tasks={[]} bets={[]} />, { wrapper })
		expect(screen.getByText('No tasks yet')).toBeInTheDocument()
	})

	it('renders kanban columns for status grouping by default', () => {
		const tasks = [
			buildObjectResponse({ type: 'task', status: 'in_progress', title: 'Active task' }),
			buildObjectResponse({ type: 'task', status: 'todo', title: 'Queued task' }),
		]
		render(<TasksBoard tasks={tasks} bets={[]} />, { wrapper })
		expect(screen.getByText('In progress')).toBeInTheDocument()
		expect(screen.getByText('To do')).toBeInTheDocument()
	})

	it('shows overview stats correctly', () => {
		const tasks = [
			buildObjectResponse({ type: 'task', status: 'in_progress' }),
			buildObjectResponse({ type: 'task', status: 'in_progress' }),
			buildObjectResponse({ type: 'task', status: 'blocked' }),
			buildObjectResponse({ type: 'task', status: 'review' }),
			buildObjectResponse({ type: 'task', status: 'todo' }),
		]
		render(<TasksBoard tasks={tasks} bets={[]} />, { wrapper })
		// Count appears in both the overview row and the column header — use getAllByText
		expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1) // 2 in progress
		expect(screen.getByText('in progress')).toBeInTheDocument()
		expect(screen.getByText('need review')).toBeInTheDocument()
		expect(screen.getByText('blocked')).toBeInTheDocument()
		expect(screen.getByText('queued')).toBeInTheDocument()
	})

	it('hides done column by default', () => {
		const tasks = [
			buildObjectResponse({ type: 'task', status: 'done', title: 'Done task' }),
			buildObjectResponse({ type: 'task', status: 'todo', title: 'Open task' }),
		]
		render(<TasksBoard tasks={tasks} bets={[]} />, { wrapper })
		expect(screen.queryByText('Done')).not.toBeInTheDocument()
		expect(screen.getByText('Open task')).toBeInTheDocument()
	})

	it('shows done column after toggling Hide done', async () => {
		const user = userEvent.setup()
		const tasks = [buildObjectResponse({ type: 'task', status: 'done', title: 'Done task' })]
		render(<TasksBoard tasks={tasks} bets={[]} />, { wrapper })
		await user.click(screen.getByText(/Hide done/))
		expect(screen.getByText('Done')).toBeInTheDocument()
		expect(screen.getByText('Done task')).toBeInTheDocument()
	})

	it('tasks appear in correct status column', () => {
		const tasks = [buildObjectResponse({ type: 'task', status: 'blocked', title: 'Stuck task' })]
		render(<TasksBoard tasks={tasks} bets={[]} />, { wrapper })
		expect(screen.getByText('Blocked')).toBeInTheDocument()
		expect(screen.getByText('Stuck task')).toBeInTheDocument()
	})

	it('switches to owner grouping and shows owner as column header', async () => {
		const user = userEvent.setup()
		const tasks = [
			buildObjectResponse({ type: 'task', status: 'todo', owner: 'Alice', title: 'Alice task' }),
			buildObjectResponse({ type: 'task', status: 'todo', owner: null, title: 'Orphan task' }),
		]
		render(<TasksBoard tasks={tasks} bets={[]} />, { wrapper })
		await user.click(screen.getByRole('button', { name: 'Owner' }))
		// Alice's name appears as a column header (uppercase via CSS, but text content is 'Alice')
		expect(screen.getByText('Alice')).toBeInTheDocument()
		// Unassigned column appears for tasks with no owner
		expect(screen.getByText('Unassigned')).toBeInTheDocument()
		// Both tasks are visible
		expect(screen.getByText('Alice task')).toBeInTheDocument()
		expect(screen.getByText('Orphan task')).toBeInTheDocument()
	})

	it('shows parent bet title on card when bet provided', () => {
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', title: 'Big Bet' })
		const task = buildObjectResponse({
			type: 'task',
			status: 'todo',
			metadata: { bet_id: 'bet-1' },
		})
		render(<TasksBoard tasks={[task]} bets={[bet]} />, { wrapper })
		expect(screen.getByText('Big Bet')).toBeInTheDocument()
	})
})
