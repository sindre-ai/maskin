import type { ConversationListItemResponse } from '@/lib/api'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../setup'

vi.mock('@/lib/api', () => ({
	api: { conversations: { updateMe: vi.fn(), retryMessage: vi.fn(), list: vi.fn() } },
}))

const { toast, track } = vi.hoisted(() => ({
	toast: Object.assign(vi.fn(), { error: vi.fn() }),
	track: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/analytics', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/analytics')>()),
	trackChatRowAction: track,
}))

import { useChatRowActions } from '@/hooks/use-chat-row-actions'
import { api } from '@/lib/api'

const row = {
	id: 'conv-1',
	error: { reason: 'usage_limit', message_id: 42 },
} as unknown as ConversationListItemResponse

describe('useChatRowActions', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(api.conversations.updateMe).mockResolvedValue({} as never)
		vi.mocked(api.conversations.retryMessage).mockResolvedValue({ retried: true })
	})

	it('Done archives the chat and offers Undo for 6 seconds', () => {
		const { result } = renderHook(() => useChatRowActions('ws-1'), { wrapper: TestWrapper })
		act(() => result.current.done(row, 'hover'))
		expect(api.conversations.updateMe).toHaveBeenCalledWith('conv-1', 'ws-1', { archived: true })
		expect(track).toHaveBeenCalledWith({ action: 'done', via: 'hover' })
		const [text, options] = toast.mock.calls[0]
		expect(text).toBe('Marked done')
		expect(options.duration).toBe(6000)
		expect(options.action.label).toBe('Undo')
		act(() => options.action.onClick())
		expect(api.conversations.updateMe).toHaveBeenLastCalledWith('conv-1', 'ws-1', {
			archived: false,
		})
		expect(track).toHaveBeenLastCalledWith({ action: 'undo', via: 'hover' })
	})

	it('Later sets the flag and the toast says a new message brings it back', () => {
		const { result } = renderHook(() => useChatRowActions('ws-1'), { wrapper: TestWrapper })
		act(() => result.current.later(row, 'menu'))
		expect(api.conversations.updateMe).toHaveBeenCalledWith('conv-1', 'ws-1', { later: true })
		expect(toast.mock.calls[0][0]).toBe('Moved to Later. A new message brings it back.')
		expect(track).toHaveBeenCalledWith({ action: 'later', via: 'menu' })
	})

	it('Retry re-runs the last person message and says Retrying', async () => {
		const { result } = renderHook(() => useChatRowActions('ws-1'), { wrapper: TestWrapper })
		await act(() => result.current.retry(row, 'hover'))
		expect(api.conversations.retryMessage).toHaveBeenCalledWith('conv-1', 'ws-1', 42)
		expect(toast).toHaveBeenCalledWith('Retrying')
		expect(track).toHaveBeenCalledWith({ action: 'retry', via: 'hover' })
	})

	it('Retry tells the person when the call fails', async () => {
		vi.mocked(api.conversations.retryMessage).mockRejectedValue(new Error('no'))
		const { result } = renderHook(() => useChatRowActions('ws-1'), { wrapper: TestWrapper })
		await act(() => result.current.retry(row, 'menu'))
		expect(toast.error).toHaveBeenCalledWith('Failed to retry')
	})
})
