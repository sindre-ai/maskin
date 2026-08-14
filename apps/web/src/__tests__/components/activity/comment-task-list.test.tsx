import { CommentTaskList, hasTaskList } from '@/components/activity/comment-task-list'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildActorListItem, buildEventResponse, buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const mockUseObject = vi.hoisted(() => vi.fn())
const mockUseActor = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-objects', () => ({
	useObject: (id: string) => mockUseObject(id),
}))
vi.mock('@/hooks/use-actors', () => ({
	useActor: (id: string) => mockUseActor(id),
}))

// @tanstack/react-router's <Link> needs a router; for these tests we only care
// that the link exists with the task's title, so render it as a plain <span>
// (no href, since Biome's a11y rules reject "#" / empty hrefs).
vi.mock('@tanstack/react-router', () => ({
	Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
		<span className={className}>{children as React.ReactNode}</span>
	),
}))

const TASK_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const TASK_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'

function eventWithTasks(tasks: unknown[]) {
	return buildEventResponse({
		action: 'commented',
		data: { content: 'progress', metadata: { tasks } },
	})
}

describe('hasTaskList', () => {
	it('returns false for non-commented events', () => {
		const event = buildEventResponse({ action: 'created' })
		expect(hasTaskList(event)).toBe(false)
	})

	it('returns false when metadata.tasks is missing', () => {
		const event = buildEventResponse({ action: 'commented', data: { content: 'hi' } })
		expect(hasTaskList(event)).toBe(false)
	})

	it('returns false when no entries are valid UUIDs', () => {
		const event = eventWithTasks(['not-a-uuid', 123])
		expect(hasTaskList(event)).toBe(false)
	})

	it('returns true when at least one valid UUID is present', () => {
		expect(hasTaskList(eventWithTasks([TASK_A]))).toBe(true)
	})
})

describe('CommentTaskList', () => {
	beforeEach(() => {
		mockUseObject.mockReset()
		mockUseActor.mockReset()
		mockUseActor.mockReturnValue({ data: undefined })
	})

	it('renders a checked checkbox for done tasks', () => {
		mockUseObject.mockReturnValue({
			data: buildObjectResponse({
				id: TASK_A,
				type: 'task',
				status: 'done',
				title: 'Ship renderer',
			}),
			isLoading: false,
		})
		render(
			<TestWrapper>
				<CommentTaskList event={eventWithTasks([TASK_A])} workspaceId="ws-1" />
			</TestWrapper>,
		)
		expect(screen.getByText('Ship renderer')).toBeInTheDocument()
		const cb = screen.getByRole('checkbox') as HTMLButtonElement
		expect(cb.getAttribute('data-state')).toBe('checked')
	})

	it('renders an unchecked checkbox for non-terminal tasks', () => {
		mockUseObject.mockReturnValue({
			data: buildObjectResponse({
				id: TASK_A,
				type: 'task',
				status: 'in_progress',
				title: 'Write spec',
			}),
			isLoading: false,
		})
		render(
			<TestWrapper>
				<CommentTaskList event={eventWithTasks([TASK_A])} workspaceId="ws-1" />
			</TestWrapper>,
		)
		const cb = screen.getByRole('checkbox') as HTMLButtonElement
		expect(cb.getAttribute('data-state')).toBe('unchecked')
	})

	it('renders a muted "deleted task" row when the object is missing', () => {
		mockUseObject.mockReturnValue({ data: undefined, isLoading: false })
		render(
			<TestWrapper>
				<CommentTaskList event={eventWithTasks([TASK_A])} workspaceId="ws-1" />
			</TestWrapper>,
		)
		expect(screen.getByText('deleted task')).toBeInTheDocument()
	})

	it('renders strikethrough for archived/discarded tasks', () => {
		mockUseObject.mockReturnValue({
			data: buildObjectResponse({
				id: TASK_B,
				type: 'task',
				status: 'discarded',
				title: 'Old idea',
			}),
			isLoading: false,
		})
		render(
			<TestWrapper>
				<CommentTaskList event={eventWithTasks([TASK_B])} workspaceId="ws-1" />
			</TestWrapper>,
		)
		const link = screen.getByText('Old idea')
		expect(link.className).toMatch(/line-through/)
	})

	it('renders the task driver avatar when present', () => {
		mockUseObject.mockReturnValue({
			data: buildObjectResponse({
				id: TASK_A,
				type: 'task',
				status: 'in_progress',
				title: 'Owned task',
				driver: 'agent-1',
			}),
			isLoading: false,
		})
		mockUseActor.mockReturnValue({
			data: buildActorListItem({ id: 'agent-1', name: 'Developer', type: 'agent' }),
		})
		render(
			<TestWrapper>
				<CommentTaskList event={eventWithTasks([TASK_A])} workspaceId="ws-1" />
			</TestWrapper>,
		)
		expect(screen.getByTitle('Driver: Developer')).toBeInTheDocument()
	})
})
