import { ThreadComposer } from '@/components/chat/thread-composer'
import type { UnifiedChatSlashPickerProps } from '@/components/chat/unified-slash-picker'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { buildObjectResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const mockMutateAsync = vi.fn()

vi.mock('@/hooks/use-conversation', () => ({
	useSendMessage: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
	// The composer names who you are answering ("Reply to Forge…"), so it reads
	// the conversation's participants alongside the send mutation.
	useConversation: () => ({ data: undefined }),
	// The cue reads the thread cache.
	useConversationMessages: () => ({ data: undefined, hasNextPage: false }),
	flattenMessagesOldestFirst: () => [],
}))

vi.mock('@/hooks/use-actors', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-actors')>('@/hooks/use-actors')
	return { ...actual, useActors: () => ({ data: [] }) }
})

vi.mock('@/components/chat/unified-slash-picker', async () => {
	const { forwardRef } = await import('react')
	return {
		UnifiedChatSlashPicker: forwardRef(function MockUnifiedPicker(
			{ onSelect }: UnifiedChatSlashPickerProps,
			_ref,
		) {
			return (
				<div>
					<button
						type="button"
						onClick={() =>
							onSelect({
								kind: 'reference',
								object: buildObjectResponse({ id: 'obj-1', title: 'First bet', type: 'bet' }),
							})
						}
					>
						pick-object-1
					</button>
					<button
						type="button"
						onClick={() =>
							onSelect({
								kind: 'reference',
								object: buildObjectResponse({ id: 'obj-2', title: 'Second bet', type: 'bet' }),
							})
						}
					>
						pick-object-2
					</button>
				</div>
			)
		}),
	}
})

describe('ThreadComposer — multi-item selection', () => {
	it('sends every picked object as structured metadata', async () => {
		mockMutateAsync.mockResolvedValueOnce({})
		const user = userEvent.setup()
		render(<ThreadComposer workspaceId="ws-1" conversationId="convo-1" />, {
			wrapper: createWorkspaceWrapper(),
		})

		await user.click(screen.getByText('pick-object-1'))
		await user.click(screen.getByText('pick-object-2'))

		// Picked items render as removable chips in the composer before send.
		expect(screen.getByText('First bet')).toBeInTheDocument()
		expect(screen.getByText('Second bet')).toBeInTheDocument()

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
				}),
			}),
		)
	})
})

describe('ThreadComposer — draft persistence', () => {
	it('restores an unsent draft after the composer remounts', async () => {
		sessionStorage.clear()
		const user = userEvent.setup()
		const first = render(<ThreadComposer workspaceId="ws-1" conversationId="convo-1" />, {
			wrapper: createWorkspaceWrapper(),
		})

		await user.type(screen.getByLabelText('Message this conversation'), 'half-written prompt')
		first.unmount()

		render(<ThreadComposer workspaceId="ws-1" conversationId="convo-1" />, {
			wrapper: createWorkspaceWrapper(),
		})
		expect(screen.getByLabelText('Message this conversation')).toHaveTextContent(
			'half-written prompt',
		)
	})

	it('does not carry a draft into another conversation', async () => {
		sessionStorage.clear()
		const user = userEvent.setup()
		const { rerender } = render(<ThreadComposer workspaceId="ws-1" conversationId="convo-1" />, {
			wrapper: createWorkspaceWrapper(),
		})
		await user.type(screen.getByLabelText('Message this conversation'), 'for convo one')

		rerender(<ThreadComposer workspaceId="ws-1" conversationId="convo-2" />)
		expect(screen.getByLabelText('Message this conversation').textContent).toBe('')
	})
})
