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

vi.mock('sonner', () => ({
	toast: vi.fn(),
}))

import { PersistentReplyBar } from '@/components/foryou/persistent-reply-bar'

const noop = () => {}

describe('PersistentReplyBar', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('shows idle label when no card is active', () => {
		render(
			<PersistentReplyBar
				workspaceId="ws-1"
				activeId={null}
				activeTitle={null}
				onClear={noop}
				onSent={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('Select a card to reply')).toBeInTheDocument()
	})

	it('shows replying-to label with the card title when a card is active', () => {
		render(
			<PersistentReplyBar
				workspaceId="ws-1"
				activeId="obj-1"
				activeTitle="Some Bet"
				onClear={noop}
				onSent={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('Replying to: Some Bet')).toBeInTheDocument()
	})

	it('send button is disabled when content is empty', () => {
		render(
			<PersistentReplyBar
				workspaceId="ws-1"
				activeId="obj-1"
				activeTitle="Some Bet"
				onClear={noop}
				onSent={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByRole('button', { name: /send reply/i })).toBeDisabled()
	})

	it('send button is disabled when no card is active', () => {
		render(
			<PersistentReplyBar
				workspaceId="ws-1"
				activeId={null}
				activeTitle={null}
				onClear={noop}
				onSent={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByRole('button', { name: /send reply/i })).toBeDisabled()
	})

	it('clears input after successful send', async () => {
		mockMutate.mockImplementation((_args: unknown, opts?: { onSuccess?: () => void }) => {
			opts?.onSuccess?.()
		})
		const user = userEvent.setup()
		render(
			<PersistentReplyBar
				workspaceId="ws-1"
				activeId="obj-1"
				activeTitle="Some Bet"
				onClear={noop}
				onSent={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const textarea = screen.getByRole('textbox')
		await user.type(textarea, 'hello')
		expect(textarea).toHaveValue('hello')
		await user.click(screen.getByRole('button', { name: /send reply/i }))
		expect(textarea).toHaveValue('')
	})

	it('calls onSent after a successful send so the thread is marked read', async () => {
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
				onClear={noop}
				onSent={onSent}
			/>,
			{ wrapper: TestWrapper },
		)
		await user.type(screen.getByRole('textbox'), 'hello')
		await user.click(screen.getByRole('button', { name: /send reply/i }))
		expect(onSent).toHaveBeenCalledTimes(1)
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
				onClear={noop}
				onSent={onSent}
			/>,
			{ wrapper: TestWrapper },
		)
		await user.type(screen.getByRole('textbox'), 'hello')
		await user.click(screen.getByRole('button', { name: /send reply/i }))
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
				onClear={onClear}
				onSent={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		await user.click(screen.getByRole('button', { name: /clear selection/i }))
		expect(onClear).toHaveBeenCalled()
	})
})
