import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TestWrapper } from '../../setup'

const mockMutate = vi.fn()

vi.mock('@/components/ui/sidebar', () => ({
	useSidebar: () => ({ open: true }),
}))

vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => false,
}))

vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: mockMutate, isPending: false }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({
		data: [
			{ id: 'alice', name: 'Alice', type: 'human', isSystem: false },
			{ id: 'system-1', name: 'System', type: 'agent', isSystem: true },
		],
	}),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'viewer', name: 'Viewer', type: 'human', email: null }),
}))

vi.mock('sonner', () => ({
	toast: vi.fn(),
}))

import { PersistentReplyBar } from '@/components/foryou/persistent-reply-bar'

const noop = () => {}

describe('PersistentReplyBar', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders nothing when no card is active', () => {
		const { container } = render(
			<PersistentReplyBar
				workspaceId="ws-1"
				activeId={null}
				activeTitle={null}
				parentEventId={null}
				onClear={noop}
				onSent={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(container.firstChild).toBeNull()
	})

	it('shows replying-to label and the shared comment composer when a card is active', () => {
		render(
			<PersistentReplyBar
				workspaceId="ws-1"
				activeId="obj-1"
				activeTitle="Some Bet"
				parentEventId={null}
				onClear={noop}
				onSent={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('Replying to: Some Bet')).toBeInTheDocument()
		expect(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
		).toBeInTheDocument()
	})

	it('shows the @-mention autocomplete dropdown when typing "@" — same as the object detail page', async () => {
		const user = userEvent.setup()
		render(
			<PersistentReplyBar
				workspaceId="ws-1"
				activeId="obj-1"
				activeTitle="Some Bet"
				parentEventId={null}
				onClear={noop}
				onSent={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		await user.type(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
			'@Ali',
		)
		expect(screen.getByText('Alice')).toBeInTheDocument()
	})

	it('sends the reply as a nested reply using parentEventId', async () => {
		const user = userEvent.setup()
		mockMutate.mockImplementation((_args: unknown, opts?: { onSuccess?: () => void }) => {
			opts?.onSuccess?.()
		})
		render(
			<PersistentReplyBar
				workspaceId="ws-1"
				activeId="obj-1"
				activeTitle="Some Bet"
				parentEventId={42}
				onClear={noop}
				onSent={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		await user.type(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
			'hello{Enter}',
		)
		expect(mockMutate).toHaveBeenCalledWith(
			expect.objectContaining({ entity_id: 'obj-1', content: 'hello', parent_event_id: 42 }),
			expect.anything(),
		)
	})

	it('calls onSent and shows a toast after a successful send', async () => {
		const { toast } = await import('sonner')
		mockMutate.mockImplementation((_args: unknown, opts?: { onSuccess?: () => void }) => {
			opts?.onSuccess?.()
		})
		const user = userEvent.setup()
		const onSent = vi.fn()
		render(
			<PersistentReplyBar
				workspaceId="ws-1"
				activeId="obj-1"
				activeTitle="Some Bet"
				parentEventId={null}
				onClear={noop}
				onSent={onSent}
			/>,
			{ wrapper: TestWrapper },
		)
		await user.type(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
			'hello{Enter}',
		)
		expect(onSent).toHaveBeenCalledTimes(1)
		expect(toast).toHaveBeenCalledWith('Reply sent')
	})

	it('does not call onSent when send fails', async () => {
		mockMutate.mockImplementation(() => {
			// no onSuccess invocation simulates a failed mutation
		})
		const user = userEvent.setup()
		const onSent = vi.fn()
		render(
			<PersistentReplyBar
				workspaceId="ws-1"
				activeId="obj-1"
				activeTitle="Some Bet"
				parentEventId={null}
				onClear={noop}
				onSent={onSent}
			/>,
			{ wrapper: TestWrapper },
		)
		await user.type(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
			'hello{Enter}',
		)
		expect(onSent).not.toHaveBeenCalled()
	})

	it('calls onClear when the clear selection button is clicked', async () => {
		const user = userEvent.setup()
		const onClear = vi.fn()
		render(
			<PersistentReplyBar
				workspaceId="ws-1"
				activeId="obj-1"
				activeTitle="Some Bet"
				parentEventId={null}
				onClear={onClear}
				onSent={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		await user.click(screen.getByRole('button', { name: /clear selection/i }))
		expect(onClear).toHaveBeenCalled()
	})

	it('mounts a fresh composer when the active card changes, discarding any unsent draft', () => {
		const { rerender } = render(
			<PersistentReplyBar
				workspaceId="ws-1"
				activeId="obj-1"
				activeTitle="Some Bet"
				parentEventId={null}
				onClear={noop}
				onSent={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const firstTextarea = screen.getByPlaceholderText(
			'Write a comment... Use @ to mention an agent',
		) as HTMLTextAreaElement
		firstTextarea.value = 'unsent draft'

		rerender(
			<PersistentReplyBar
				workspaceId="ws-1"
				activeId="obj-2"
				activeTitle="Another Bet"
				parentEventId={null}
				onClear={noop}
				onSent={noop}
			/>,
		)
		const secondTextarea = screen.getByPlaceholderText(
			'Write a comment... Use @ to mention an agent',
		) as HTMLTextAreaElement
		expect(secondTextarea.value).toBe('')
	})
})
