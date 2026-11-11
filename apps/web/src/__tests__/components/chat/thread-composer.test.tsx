import { ThreadComposer } from '@/components/chat/thread-composer'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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
