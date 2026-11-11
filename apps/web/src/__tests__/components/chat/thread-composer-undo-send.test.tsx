import { ThreadComposer } from '@/components/chat/thread-composer'
import { UNDO_SEND_WINDOW_MS } from '@/hooks/use-undo-send'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const mockMutateAsync = vi.fn()
const flag = vi.hoisted(() => ({ on: true }))

vi.mock('@/hooks/use-feature-flag', () => ({ useFeatureFlag: () => flag.on }))
vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))
vi.mock('@/hooks/use-actors', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-actors')>()),
	useActors: () => ({ data: [] }),
}))
vi.mock('@/hooks/use-conversation', () => ({
	useSendMessage: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
	useConversation: () => ({ data: undefined }),
	useConversationMessages: () => ({ data: undefined, hasNextPage: false }),
	flattenMessagesOldestFirst: () => [],
}))

function renderComposer() {
	return render(<ThreadComposer workspaceId="ws-1" conversationId="conv-1" />, {
		wrapper: createWorkspaceWrapper(),
	})
}

describe('ThreadComposer undo send', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		sessionStorage.clear()
		flag.on = true
		mockMutateAsync.mockResolvedValue({})
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('holds the message behind an Undo bar and posts it when the window ends', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
		renderComposer()

		await user.type(await screen.findByLabelText('Message this conversation'), 'hello')
		await user.click(screen.getByRole('button', { name: 'Send message' }))

		expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
		expect(mockMutateAsync).not.toHaveBeenCalled()

		await act(() => vi.advanceTimersByTimeAsync(UNDO_SEND_WINDOW_MS))
		expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello' }))
		expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
	})

	it('Undo puts the text back in the box and posts nothing', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
		renderComposer()

		const box = await screen.findByLabelText('Message this conversation')
		await user.type(box, 'hello')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await user.click(screen.getByRole('button', { name: 'Undo' }))
		await act(() => vi.advanceTimersByTimeAsync(UNDO_SEND_WINDOW_MS * 2))

		expect(mockMutateAsync).not.toHaveBeenCalled()
		expect(await screen.findByLabelText('Message this conversation')).toHaveTextContent('hello')
		expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
	})

	it('with the flag off posts at once and shows no Undo bar', async () => {
		flag.on = false
		const user = userEvent.setup()
		renderComposer()

		await user.type(await screen.findByLabelText('Message this conversation'), 'hello')
		await user.click(screen.getByRole('button', { name: 'Send message' }))

		expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello' }))
		expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
	})
})
