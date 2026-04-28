import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { buildActorListItem, buildNotificationResponse } from '../../factories'

const mockUseNotifications = vi.fn()
const mockUseActors = vi.fn()
const mockRespondMutate = vi.fn()
const mockUpdateMutate = vi.fn()
const mockNavigate = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return {
		...mockTanStackRouter(),
		useNavigate: () => mockNavigate,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@/hooks/use-notifications', () => ({
	useNotifications: (...args: unknown[]) => mockUseNotifications(...args),
	useRespondNotification: () => ({ mutate: mockRespondMutate }),
	useUpdateNotification: () => ({ mutate: mockUpdateMutate }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: (...args: unknown[]) => mockUseActors(...args),
}))

vi.mock('sonner', () => ({
	toast: { error: vi.fn() },
}))

vi.mock('@/components/shared/markdown-content', () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}))

vi.mock('@/components/shared/relative-time', () => ({
	RelativeTime: ({ date }: { date: string | null }) => <span>{date}</span>,
}))

import { DecisionsPanel } from '@/components/dashboard/decisions-panel'

describe('DecisionsPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseActors.mockReturnValue({ data: [buildActorListItem({ id: 'actor-1', name: 'Eli' })] })
	})

	it('returns nothing while loading', () => {
		mockUseNotifications.mockReturnValue({ data: undefined, isLoading: true })
		const { container } = render(<DecisionsPanel />)
		expect(container).toBeEmptyDOMElement()
	})

	it('returns nothing when no decisions are pending (empties to zero)', () => {
		mockUseNotifications.mockReturnValue({ data: [], isLoading: false })
		const { container } = render(<DecisionsPanel />)
		expect(container).toBeEmptyDOMElement()
	})

	it('hides good_news notifications (informational, not actionable)', () => {
		const notifications = [
			buildNotificationResponse({ id: 'n-1', type: 'good_news', title: 'Yay' }),
		]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		const { container } = render(<DecisionsPanel />)
		expect(container).toBeEmptyDOMElement()
	})

	it('renders the agent plan as the body of each card', () => {
		const notifications = [
			buildNotificationResponse({
				id: 'n-1',
				title: 'Approve onboarding copy',
				content: 'I am proposing this copy: "Welcome aboard."',
			}),
		]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<DecisionsPanel />)
		expect(screen.getByText('Approve onboarding copy')).toBeInTheDocument()
		expect(screen.getByText(/I am proposing this copy/)).toBeInTheDocument()
	})

	it('renders the three steer actions on each card', () => {
		const notifications = [buildNotificationResponse({ id: 'n-1' })]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<DecisionsPanel />)
		expect(screen.getByRole('button', { name: /Ship it/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Ask for changes/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Take over/ })).toBeInTheDocument()
	})

	it('fires respondNotification with approved when Ship it is clicked', async () => {
		const user = userEvent.setup()
		const notifications = [buildNotificationResponse({ id: 'n-1' })]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<DecisionsPanel />)
		await user.click(screen.getByRole('button', { name: /Ship it/ }))
		expect(mockRespondMutate).toHaveBeenCalledWith(
			{ id: 'n-1', response: 'approved' },
			expect.anything(),
		)
	})

	it('reveals a revision input when Ask for changes is clicked', async () => {
		const user = userEvent.setup()
		const notifications = [buildNotificationResponse({ id: 'n-1' })]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<DecisionsPanel />)
		await user.click(screen.getByRole('button', { name: /Ask for changes/ }))
		expect(screen.getByPlaceholderText(/What should change/)).toBeInTheDocument()
	})

	it('sends a text reply when revision is submitted', async () => {
		const user = userEvent.setup()
		const notifications = [buildNotificationResponse({ id: 'n-1' })]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<DecisionsPanel />)
		await user.click(screen.getByRole('button', { name: /Ask for changes/ }))
		await user.type(screen.getByPlaceholderText(/What should change/), 'tighten the headline')
		await user.click(screen.getByRole('button', { name: 'Send' }))
		expect(mockRespondMutate).toHaveBeenCalledWith(
			{ id: 'n-1', response: { type: 'text_reply', message: 'tighten the headline' } },
			expect.anything(),
		)
	})

	it('navigates to the linked object when Take over is clicked', async () => {
		const user = userEvent.setup()
		const notifications = [
			buildNotificationResponse({
				id: 'n-1',
				status: 'pending',
				objectId: '00000000-0000-0000-0000-000000000099',
			}),
		]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<DecisionsPanel />)
		await user.click(screen.getByRole('button', { name: /Take over/ }))
		expect(mockUpdateMutate).toHaveBeenCalledWith({ id: 'n-1', data: { status: 'seen' } })
		expect(mockNavigate).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '/ws-1/objects/00000000-0000-0000-0000-000000000099',
			}),
		)
	})

	it('keeps raw permission prompts collapsed by default', () => {
		const notifications = [
			buildNotificationResponse({
				id: 'n-1',
				metadata: { tool_name: 'delete_user_data', permission_prompt: 'Allow tool call?' },
			}),
		]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<DecisionsPanel />)
		expect(screen.queryByText(/Allow tool call/)).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: /View raw permission request/ })).toBeInTheDocument()
	})

	it('reveals raw permission detail when toggled open', async () => {
		const user = userEvent.setup()
		const notifications = [
			buildNotificationResponse({
				id: 'n-1',
				metadata: { tool_name: 'delete_user_data', permission_prompt: 'Allow tool call?' },
			}),
		]
		mockUseNotifications.mockReturnValue({ data: notifications, isLoading: false })
		render(<DecisionsPanel />)
		await user.click(screen.getByRole('button', { name: /View raw permission request/ }))
		expect(screen.getByText(/Allow tool call/)).toBeInTheDocument()
		expect(screen.getByText('delete_user_data')).toBeInTheDocument()
	})

	it('passes status pending,seen to useNotifications so resolved cards drop out', () => {
		mockUseNotifications.mockReturnValue({ data: [], isLoading: false })
		render(<DecisionsPanel />)
		expect(mockUseNotifications).toHaveBeenCalledWith('ws-1', { status: 'pending,seen' })
	})
})
