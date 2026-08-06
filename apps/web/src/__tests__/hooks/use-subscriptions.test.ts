import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		subscriptions: {
			subscribe: vi.fn(),
			unsubscribe: vi.fn(),
			subscribers: vi.fn(),
			markRead: vi.fn(),
			markUnread: vi.fn(),
			unread: vi.fn(),
		},
	},
}))

import {
	useMarkRead,
	useMarkUnread,
	useSubscribe,
	useSubscribers,
	useUnread,
	useUnsubscribe,
} from '@/hooks/use-subscriptions'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

describe('useSubscriptions', () => {
	beforeEach(() => vi.clearAllMocks())

	describe('useSubscribers', () => {
		it('fetches subscribers and exposes the actors list', async () => {
			const subscribers = {
				actors: [{ id: 'a1', type: 'human', name: 'Alice' }],
			}
			vi.mocked(api.subscriptions.subscribers).mockResolvedValue(subscribers)

			const { result } = renderHook(() => useSubscribers('ws-1', 'object', 'obj-1'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(result.current.data).toEqual(subscribers)
			expect(api.subscriptions.subscribers).toHaveBeenCalledWith('ws-1', 'object', 'obj-1')
		})

		it('skips the fetch when entityId is empty', () => {
			vi.mocked(api.subscriptions.subscribers).mockResolvedValue({ actors: [] })

			const { result } = renderHook(() => useSubscribers('ws-1', 'object', ''), {
				wrapper: TestWrapper,
			})

			expect(result.current.fetchStatus).toBe('idle')
			expect(api.subscriptions.subscribers).not.toHaveBeenCalled()
		})
	})

	describe('useUnread', () => {
		it('fetches the unread feed for the workspace', async () => {
			const payload = {
				items: [
					{
						entity_type: 'object',
						entity_id: 'obj-1',
						unread_count: 3,
						mentioning_unread_count: 0,
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

	describe('useSubscribe', () => {
		it('calls the API and resolves on success', async () => {
			vi.mocked(api.subscriptions.subscribe).mockResolvedValue({ subscribed: true })

			const { result } = renderHook(() => useSubscribe('ws-1'), { wrapper: TestWrapper })

			result.current.mutate({ entityType: 'object', entityId: 'obj-1' })
			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.subscriptions.subscribe).toHaveBeenCalledWith('ws-1', 'object', 'obj-1')
		})
	})

	describe('useUnsubscribe', () => {
		it('calls the API and resolves on success', async () => {
			vi.mocked(api.subscriptions.unsubscribe).mockResolvedValue({ unsubscribed: true })

			const { result } = renderHook(() => useUnsubscribe('ws-1'), { wrapper: TestWrapper })

			result.current.mutate({ entityType: 'object', entityId: 'obj-1' })
			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.subscriptions.unsubscribe).toHaveBeenCalledWith('ws-1', 'object', 'obj-1')
		})
	})

	describe('useMarkRead', () => {
		it('calls the API with the last event id', async () => {
			vi.mocked(api.subscriptions.markRead).mockResolvedValue({ updated: true })

			const { result } = renderHook(() => useMarkRead('ws-1'), { wrapper: TestWrapper })

			result.current.mutate({
				entityType: 'object',
				entityId: 'obj-1',
				lastEventId: 42,
			})
			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.subscriptions.markRead).toHaveBeenCalledWith('ws-1', 'object', 'obj-1', 42)
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
