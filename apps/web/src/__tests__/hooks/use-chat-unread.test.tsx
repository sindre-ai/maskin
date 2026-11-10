import { useChatUnreadCount } from '@/hooks/use-chat-unread'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: { conversations: { unreadCount: vi.fn() } },
}))

function wrapperFor(client: QueryClient) {
	return ({ children }: { children: React.ReactNode }) =>
		React.createElement(QueryClientProvider, { client }, children)
}

describe('useChatUnreadCount', () => {
	it('reads the exact count from the count-only endpoint', async () => {
		vi.mocked(api.conversations.unreadCount).mockResolvedValue({ count: 42 })
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const { result } = renderHook(() => useChatUnreadCount('ws-1'), { wrapper: wrapperFor(client) })
		await waitFor(() => expect(result.current.count).toBe(42))
		expect(result.current.hasMore).toBe(false)
		expect(api.conversations.unreadCount).toHaveBeenCalledWith('ws-1')
	})

	it('is 0 before the first answer and does not fetch without a workspace', () => {
		vi.mocked(api.conversations.unreadCount).mockClear()
		const client = new QueryClient()
		const { result } = renderHook(() => useChatUnreadCount(''), { wrapper: wrapperFor(client) })
		expect(result.current).toEqual({ count: 0, hasMore: false })
		expect(api.conversations.unreadCount).not.toHaveBeenCalled()
	})

	it('shares the conversations.unreadCount cache key, so conversations.all invalidates it', async () => {
		vi.mocked(api.conversations.unreadCount).mockResolvedValue({ count: 3 })
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const { result } = renderHook(() => useChatUnreadCount('ws-1'), { wrapper: wrapperFor(client) })
		await waitFor(() => expect(result.current.count).toBe(3))
		expect(client.getQueryData(queryKeys.conversations.unreadCount('ws-1'))).toEqual({ count: 3 })
		vi.mocked(api.conversations.unreadCount).mockResolvedValue({ count: 0 })
		await client.invalidateQueries({ queryKey: queryKeys.conversations.all('ws-1') })
		await waitFor(() => expect(result.current.count).toBe(0))
	})
})
