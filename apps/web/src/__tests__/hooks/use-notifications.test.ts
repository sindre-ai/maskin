import { renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		notifications: {
			list: vi.fn(),
			update: vi.fn(),
			respond: vi.fn(),
			delete: vi.fn(),
		},
	},
}))

import {
	useDeleteNotification,
	useNotifications,
	useRespondNotification,
	useUpdateNotification,
} from '@/hooks/use-notifications'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

describe('useNotifications', () => {
	beforeEach(() => vi.clearAllMocks())

	describe('useNotifications', () => {
		it('returns notifications for workspace', async () => {
			const notifications = [
				{ id: 'n1', title: 'Notification 1' },
				{ id: 'n2', title: 'Notification 2' },
			]
			vi.mocked(api.notifications.list).mockResolvedValue(notifications)

			const { result } = renderHook(() => useNotifications('ws-1'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(result.current.data).toEqual(notifications)
			expect(api.notifications.list).toHaveBeenCalledWith('ws-1', undefined)
		})

		it('passes filters to API', async () => {
			vi.mocked(api.notifications.list).mockResolvedValue([])
			const filters = { read: false }

			const { result } = renderHook(() => useNotifications('ws-1', filters), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.notifications.list).toHaveBeenCalledWith('ws-1', filters)
		})

		it('handles error', async () => {
			vi.mocked(api.notifications.list).mockRejectedValue(new Error('Failed to fetch'))

			const { result } = renderHook(() => useNotifications('ws-1'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Failed to fetch')
		})
	})

	describe('useUpdateNotification', () => {
		it('updates a notification', async () => {
			const updated = { id: 'n1', title: 'Updated', read: true }
			vi.mocked(api.notifications.update).mockResolvedValue(updated)

			const { result } = renderHook(() => useUpdateNotification('ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate({ id: 'n1', data: { read: true } })

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.notifications.update).toHaveBeenCalledWith('n1', { read: true })
		})

		it('handles update error', async () => {
			vi.mocked(api.notifications.update).mockRejectedValue(new Error('Update failed'))

			const { result } = renderHook(() => useUpdateNotification('ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate({ id: 'n1', data: { read: true } })

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Update failed')
		})
	})

	describe('useRespondNotification', () => {
		it('responds to a notification', async () => {
			const responded = { id: 'n1', status: 'responded' }
			vi.mocked(api.notifications.respond).mockResolvedValue(responded)

			const { result } = renderHook(() => useRespondNotification('ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate({ id: 'n1', response: 'approved' })

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.notifications.respond).toHaveBeenCalledWith('n1', 'approved', 'ws-1')
		})

		it('handles respond error', async () => {
			vi.mocked(api.notifications.respond).mockRejectedValue(new Error('Respond failed'))

			const { result } = renderHook(() => useRespondNotification('ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate({ id: 'n1', response: 'approved' })

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Respond failed')
		})
	})

	describe('useDeleteNotification', () => {
		it('deletes a notification', async () => {
			vi.mocked(api.notifications.delete).mockResolvedValue(undefined)

			const { result } = renderHook(() => useDeleteNotification('ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate('n1')

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.notifications.delete).toHaveBeenCalledWith('n1')
		})

		it('handles delete error', async () => {
			vi.mocked(api.notifications.delete).mockRejectedValue(new Error('Delete failed'))

			const { result } = renderHook(() => useDeleteNotification('ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate('n1')

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Delete failed')
		})
	})
})
