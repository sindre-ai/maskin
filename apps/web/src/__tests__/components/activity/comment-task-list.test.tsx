import { CommentTaskList, hasTaskList } from '@/components/activity/comment-task-list'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse, buildEventResponse, buildObjectResponse } from '../../factories'

const mockUseObject = vi.fn()
const mockUseActor = vi.fn()

vi.mock('@/hooks/use-objects', () => ({
	useObject: (id: string) => mockUseObject(id),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActor: (id: string) => mockUseActor(id),
}))

vi.mock('@tanstack/react-router', () => ({
	Link: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => (
		<a {...(props as Record<string, unknown>)}>{children}</a>
	),
}))

function tasksEvent(tasks: unknown) {
	return buildEventResponse({
		action: 'commented',
		data: { content: 'tracking', metadata: { tasks } },
	})
}

beforeEach(() => {
	mockUseObject.mockReset()
	mockUseActor.mockReset()
})

describe('hasTaskList', () => {
	it('returns false for non-commented events', () => {
		expect(
			hasTaskList(buildEventResponse({ action: 'created', data: { metadata: { tasks: ['t1'] } } })),
		).toBe(false)
	})

	it('returns false when metadata has no tasks key', () => {
		expect(hasTaskList(buildEventResponse({ action: 'commented', data: { content: 'hi' } }))).toBe(
			false,
		)
	})

	it('returns false when tasks is empty', () => {
		expect(hasTaskList(tasksEvent([]))).toBe(false)
	})

	it('returns true when tasks array has at least one string id', () => {
		expect(hasTaskList(tasksEvent(['11111111-1111-1111-1111-111111111111']))).toBe(true)
	})

	it('returns false when tasks contains only non-string entries', () => {
		expect(hasTaskList(tasksEvent([null, 0, false]))).toBe(false)
	})
})

describe('CommentTaskList', () => {
	const props = { workspaceId: 'ws-1' }

	it('renders an unchecked, named row for an in-progress task', () => {
		const task = buildObjectResponse({
			id: 't-active',
			type: 'task',
			title: 'Write the spec',
			status: 'in_progress',
			driver: null,
		})
		mockUseObject.mockReturnValue({ data: task, isLoading: false, isError: false })
		mockUseActor.mockReturnValue({ data: null })

		render(<CommentTaskList event={tasksEvent(['t-active'])} {...props} />)
		const checkbox = screen.getByRole('checkbox')
		// Radix Checkbox surfaces state via data-state; "unchecked" means box is empty.
		expect(checkbox.getAttribute('data-state')).toBe('unchecked')
		expect(screen.getByText('Write the spec')).toBeInTheDocument()
	})

	it('renders a checked row for a completed task and shows the driver name', () => {
		const task = buildObjectResponse({
			id: 't-done',
			type: 'task',
			title: 'Done item',
			status: 'completed',
			driver: 'agent-x',
		})
		const driver = buildActorResponse({ id: 'agent-x', name: 'Builder', type: 'agent' })
		mockUseObject.mockReturnValue({ data: task, isLoading: false, isError: false })
		mockUseActor.mockReturnValue({ data: driver })

		render(<CommentTaskList event={tasksEvent(['t-done'])} {...props} />)
		expect(screen.getByRole('checkbox').getAttribute('data-state')).toBe('checked')
		expect(screen.getByTitle('Driver: Builder')).toBeInTheDocument()
	})

	it('renders a muted "deleted task" placeholder when the object is missing', () => {
		mockUseObject.mockReturnValue({ data: undefined, isLoading: false, isError: false })
		mockUseActor.mockReturnValue({ data: null })

		render(<CommentTaskList event={tasksEvent(['t-gone'])} {...props} />)
		expect(screen.getByText('deleted task')).toBeInTheDocument()
		expect(screen.getByRole('checkbox')).toBeDisabled()
	})

	it('renders the deleted treatment when useObject errors', () => {
		mockUseObject.mockReturnValue({ data: undefined, isLoading: false, isError: true })
		mockUseActor.mockReturnValue({ data: null })

		render(<CommentTaskList event={tasksEvent(['t-error'])} {...props} />)
		expect(screen.getByText('deleted task')).toBeInTheDocument()
	})

	it('strikes through and mutes an archived/discarded task', () => {
		const task = buildObjectResponse({
			id: 't-arch',
			type: 'task',
			title: 'Killed item',
			status: 'discarded',
			driver: null,
		})
		mockUseObject.mockReturnValue({ data: task, isLoading: false, isError: false })
		mockUseActor.mockReturnValue({ data: null })

		render(<CommentTaskList event={tasksEvent(['t-arch'])} {...props} />)
		const link = screen.getByText('Killed item')
		expect(link.className).toMatch(/line-through/)
	})

	it('renders a skeleton placeholder while the object is loading', () => {
		mockUseObject.mockReturnValue({ data: undefined, isLoading: true, isError: false })
		mockUseActor.mockReturnValue({ data: null })

		const { container } = render(<CommentTaskList event={tasksEvent(['t-loading'])} {...props} />)
		expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
	})

	it('caps the rendered list at 20 ids', () => {
		const lots = Array.from({ length: 30 }, (_, i) => `id-${i}`)
		mockUseObject.mockImplementation((id: string) => ({
			data: buildObjectResponse({ id, title: id, type: 'task', status: 'todo', driver: null }),
			isLoading: false,
			isError: false,
		}))
		mockUseActor.mockReturnValue({ data: null })

		render(<CommentTaskList event={tasksEvent(lots)} {...props} />)
		expect(screen.getAllByRole('checkbox')).toHaveLength(20)
	})
})
