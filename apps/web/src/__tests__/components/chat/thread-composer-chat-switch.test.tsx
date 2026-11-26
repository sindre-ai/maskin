import { ThreadComposer } from '@/components/chat/thread-composer'
import { UNDO_SEND_WINDOW_MS } from '@/hooks/use-undo-send'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const mockPostMessage = vi.hoisted(() => vi.fn())

// Only undo send is switched on: the formatting box (a rich editor) does not run in jsdom.
vi.mock('@/hooks/use-feature-flag', () => ({
	useFeatureFlag: (id: string) => id === 'chat-undo-send',
}))
vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))
vi.mock('@/hooks/use-actors', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-actors')>()),
	useActors: () => ({ data: [] }),
}))
// The real send mutation: this test is about which chat it posts to.
vi.mock('@/hooks/use-conversation', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-conversation')>()),
	useConversation: () => ({ data: undefined }),
	useConversationMessages: () => ({ data: undefined, hasNextPage: false }),
	flattenMessagesOldestFirst: () => [],
}))
vi.mock('@/lib/api', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/api')>()
	return {
		...actual,
		api: {
			...actual.api,
			conversations: { ...actual.api.conversations, postMessage: mockPostMessage },
		},
	}
})

describe('ThreadComposer undo send across chats', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		sessionStorage.clear()
		mockPostMessage.mockResolvedValue({ id: 1, conversationId: 'conv-1', content: 'hello' })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('posts a held message to the chat it was sent in, after switching to another chat', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
		const wrapper = createWorkspaceWrapper()
		const { rerender } = render(<ThreadComposer workspaceId="ws-1" conversationId="conv-1" />, {
			wrapper,
		})

		await user.type(await screen.findByLabelText('Message this conversation'), 'hello')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		expect(mockPostMessage).not.toHaveBeenCalled()

		// Chat B opens inside the Undo window.
		rerender(<ThreadComposer workspaceId="ws-1" conversationId="conv-2" />)
		await act(() => vi.advanceTimersByTimeAsync(UNDO_SEND_WINDOW_MS))

		expect(mockPostMessage).toHaveBeenCalledTimes(1)
		expect(mockPostMessage).toHaveBeenCalledWith(
			'conv-1',
			'ws-1',
			expect.objectContaining({ content: 'hello' }),
		)
	})

	it('posts to the chat it is in when no switch happens', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
		render(<ThreadComposer workspaceId="ws-1" conversationId="conv-1" />, {
			wrapper: createWorkspaceWrapper(),
		})

		await user.type(await screen.findByLabelText('Message this conversation'), 'hello')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await act(() => vi.advanceTimersByTimeAsync(UNDO_SEND_WINDOW_MS))

		expect(mockPostMessage).toHaveBeenCalledWith(
			'conv-1',
			'ws-1',
			expect.objectContaining({ content: 'hello' }),
		)
		// The chat named in the call is not part of what goes on the wire.
		expect(mockPostMessage.mock.calls[0]?.[2]).not.toHaveProperty('target')
	})
})
