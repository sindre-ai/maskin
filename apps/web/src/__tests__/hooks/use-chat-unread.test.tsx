import { useChatUnreadCount } from '@/hooks/use-chat-unread'
import { queryKeys } from '@/lib/query-keys'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: { conversations: { list: vi.fn(() => new Promise(() => {})) } },
}))

describe('useChatUnreadCount', () => {
	it('counts rows that are still unread, not rows that were read but not yet refetched', () => {
		const client = new QueryClient()
		client.setQueryData(queryKeys.conversations.listInfinite('ws-1', { unread_only: true }), {
			pageParams: [0],
			pages: [
				{
					conversations: [
						{ id: 'a', unread_count: 0 },
						{ id: 'b', unread_count: 3 },
						{ id: 'c', unread_count: 1 },
					],
					has_more: false,
				},
			],
		})
		const { result } = renderHook(() => useChatUnreadCount('ws-1'), {
			wrapper: ({ children }: { children: React.ReactNode }) =>
				React.createElement(QueryClientProvider, { client }, children),
		})
		expect(result.current).toEqual({ count: 2, hasMore: false })
	})
})
