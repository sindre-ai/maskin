import type { SlashPickerProps, SlashPickerResult } from '@/components/chat/slash-picker'
import { ThreadComposer } from '@/components/chat/thread-composer'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const mockMutateAsync = vi.fn()

vi.mock('@/hooks/use-conversation', () => ({
	useSendMessage: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}))

vi.mock('@/components/chat/slash-picker', () => ({
	SlashPicker: ({ onSelect }: SlashPickerProps) => (
		<div>
			<button
				type="button"
				onClick={() =>
					onSelect({
						kind: 'object',
						ref: { id: 'obj-1', title: 'First bet', type: 'bet' },
					} satisfies SlashPickerResult)
				}
			>
				pick-object-1
			</button>
			<button
				type="button"
				onClick={() =>
					onSelect({
						kind: 'object',
						ref: { id: 'obj-2', title: 'Second bet', type: 'bet' },
					} satisfies SlashPickerResult)
				}
			>
				pick-object-2
			</button>
			<button
				type="button"
				onClick={() =>
					onSelect({
						kind: 'notification',
						ref: { id: 'notif-1', title: 'Heads up' },
					} satisfies SlashPickerResult)
				}
			>
				pick-notification-1
			</button>
		</div>
	),
}))

describe('ThreadComposer — multi-item selection', () => {
	it('sends every picked object and notification as structured metadata', async () => {
		mockMutateAsync.mockResolvedValueOnce({})
		const user = userEvent.setup()
		render(<ThreadComposer workspaceId="ws-1" conversationId="convo-1" />, {
			wrapper: createWorkspaceWrapper(),
		})

		await user.click(screen.getByText('pick-object-1'))
		await user.click(screen.getByText('pick-object-2'))
		await user.click(screen.getByText('pick-notification-1'))

		// Picked items render as removable chips in the composer before send.
		expect(screen.getByText('First bet')).toBeInTheDocument()
		expect(screen.getByText('Second bet')).toBeInTheDocument()
		expect(screen.getByText('Heads up')).toBeInTheDocument()

		await user.type(screen.getByLabelText('Message this conversation'), 'take a look')
		await user.click(screen.getByRole('button', { name: 'Send message' }))

		expect(mockMutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				content: 'take a look',
				metadata: expect.objectContaining({
					context_objects: [
						{ id: 'obj-1', title: 'First bet', type: 'bet' },
						{ id: 'obj-2', title: 'Second bet', type: 'bet' },
					],
					context_notifications: [{ id: 'notif-1', title: 'Heads up' }],
				}),
			}),
		)
	})
})
