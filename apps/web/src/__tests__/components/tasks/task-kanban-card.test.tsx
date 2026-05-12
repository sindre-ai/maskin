import { TaskKanbanCard } from '@/components/tasks/task-kanban-card'
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

describe('TaskKanbanCard', () => {
	const wrapper = createWorkspaceWrapper()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders task title', () => {
		const task = buildObjectResponse({ type: 'task', title: 'Fix the bug', status: 'todo' })
		render(<TaskKanbanCard task={task} />, { wrapper })
		expect(screen.getByText('Fix the bug')).toBeInTheDocument()
	})

	it('renders Untitled when title is null', () => {
		const task = buildObjectResponse({ type: 'task', title: null, status: 'todo' })
		render(<TaskKanbanCard task={task} />, { wrapper })
		expect(screen.getByText('Untitled')).toBeInTheDocument()
	})

	it('shows parent bet eyebrow when parentTitle provided', () => {
		const task = buildObjectResponse({ type: 'task', status: 'todo' })
		render(<TaskKanbanCard task={task} parentTitle="Big Bet" />, { wrapper })
		expect(screen.getByText('Big Bet')).toBeInTheDocument()
	})

	it('hides parent bet eyebrow when hideParent is true', () => {
		const task = buildObjectResponse({ type: 'task', status: 'todo' })
		render(<TaskKanbanCard task={task} parentTitle="Big Bet" hideParent />, { wrapper })
		expect(screen.queryByText('Big Bet')).not.toBeInTheDocument()
	})

	it('shows High priority badge for high priority tasks', () => {
		const task = buildObjectResponse({
			type: 'task',
			status: 'todo',
			metadata: { priority: 'high' },
		})
		render(<TaskKanbanCard task={task} />, { wrapper })
		expect(screen.getByText('High')).toBeInTheDocument()
	})

	it('shows Running label for in_progress tasks in comfy mode', () => {
		const task = buildObjectResponse({ type: 'task', status: 'in_progress' })
		render(<TaskKanbanCard task={task} />, { wrapper })
		expect(screen.getByText('Running')).toBeInTheDocument()
	})

	it('hides aux info in compact mode', () => {
		const task = buildObjectResponse({ type: 'task', status: 'in_progress' })
		render(<TaskKanbanCard task={task} compact />, { wrapper })
		expect(screen.queryByText('Running')).not.toBeInTheDocument()
	})

	it('shows blocked reason for blocked tasks', () => {
		const task = buildObjectResponse({
			type: 'task',
			status: 'blocked',
			metadata: { blocked_by: 'Waiting on API' },
		})
		render(<TaskKanbanCard task={task} />, { wrapper })
		expect(screen.getByText('Waiting on API')).toBeInTheDocument()
	})

	it('shows reviewer for review tasks', () => {
		const task = buildObjectResponse({
			type: 'task',
			status: 'review',
			metadata: { reviewer: 'Alice' },
		})
		render(<TaskKanbanCard task={task} />, { wrapper })
		expect(screen.getByText('Alice')).toBeInTheDocument()
	})

	it('shows owner in footer when provided', () => {
		const task = buildObjectResponse({ type: 'task', status: 'todo', owner: 'Bob' })
		render(<TaskKanbanCard task={task} />, { wrapper })
		expect(screen.getByText('Bob')).toBeInTheDocument()
	})

	it('hides owner when hideOwner is true', () => {
		const task = buildObjectResponse({ type: 'task', status: 'todo', owner: 'Bob' })
		render(<TaskKanbanCard task={task} hideOwner />, { wrapper })
		expect(screen.queryByText('Bob')).not.toBeInTheDocument()
	})

	it('navigates to object detail on click', async () => {
		const user = userEvent.setup()
		const task = buildObjectResponse({ id: 'task-42', type: 'task', status: 'todo' })
		render(<TaskKanbanCard task={task} />, { wrapper })
		await user.click(screen.getByRole('button'))
		expect(mockNavigate).toHaveBeenCalledWith(
			expect.objectContaining({ params: expect.objectContaining({ objectId: 'task-42' }) }),
		)
	})

	it('applies line-through style for done tasks', () => {
		const task = buildObjectResponse({ type: 'task', title: 'Completed work', status: 'done' })
		render(<TaskKanbanCard task={task} />, { wrapper })
		const title = screen.getByText('Completed work')
		expect(title.className).toMatch(/line-through/)
	})
})
