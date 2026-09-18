import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		subscriptions: {
			markRead: vi.fn(),
			markUnread: vi.fn(),
			unread: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { useMarkRead, useMarkUnread, useUnread } from '@/hooks/use-subscriptions'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

describe('useSubscriptions', () => {
	beforeEach(() => vi.clearAllMocks())

	describe('useUnread', () => {
		it('fetches the unread feed for the workspace', async () => {
			const payload = {
				items: [
					{
						entity_type: 'object',
						entity_id: 'obj-1',
						unread_count: 3,
						mentioning_unread_count: 0,
						max_unread_attention: null,
						latest_event_id: 42,
						latest_activity_at: null,
					},
				],
			}
			vi.mocked(api.subscriptions.unread).mockResolvedValue(payload)

			const { result } = renderHook(() => useUnread('ws-1'), { wrapper: TestWrapper })

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(result.current.data).toEqual(payload)
			expect(api.subscriptions.unread).toHaveBeenCalledWith('ws-1', undefined, undefined)
		})

		it('passes the entity_type filter when provided', async () => {
			vi.mocked(api.subscriptions.unread).mockResolvedValue({ items: [] })

			const { result } = renderHook(() => useUnread('ws-1', 'object'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.subscriptions.unread).toHaveBeenCalledWith('ws-1', 'object', undefined)
		})

		it('opts into the recently-read window when includeRecentlyRead is true', async () => {
			vi.mocked(api.subscriptions.unread).mockResolvedValue({ items: [] })

			const { result } = renderHook(() => useUnread('ws-1', undefined, true), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.subscriptions.unread).toHaveBeenCalledWith('ws-1', undefined, true)
		})
	})

	describe('useMarkUnread', () => {
		it('calls the API without a last event id', async () => {
			vi.mocked(api.subscriptions.markUnread).mockResolvedValue({ updated: true })

			const { result } = renderHook(() => useMarkUnread('ws-1'), { wrapper: TestWrapper })

			result.current.mutate({ entityType: 'object', entityId: 'obj-1' })
			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.subscriptions.markUnread).toHaveBeenCalledWith('ws-1', 'object', 'obj-1')
		})
	})
})
