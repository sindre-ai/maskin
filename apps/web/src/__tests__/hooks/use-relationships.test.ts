import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		relationships: {
			list: vi.fn(),
			create: vi.fn(),
			delete: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import {
	useCreateRelationship,
	useDeleteRelationship,
	useObjectRelationships,
	useRelationships,
} from '@/hooks/use-relationships'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { TestWrapper } from '../setup'

function buildRelationship(overrides: Record<string, unknown> = {}) {
	return {
		id: 'r1',
		sourceType: 'bet',
		sourceId: 'o1',
		targetType: 'task',
		targetId: 'o2',
		type: 'relates_to',
		createdBy: 'actor-1',
		createdAt: null,
		...overrides,
	}
}

describe('useRelationships', () => {
	beforeEach(() => vi.clearAllMocks())

	describe('useRelationships', () => {
		it('returns relationships for workspace', async () => {
			const relationships = [buildRelationship()]
			vi.mocked(api.relationships.list).mockResolvedValue(relationships)

			const { result } = renderHook(() => useRelationships('ws-1'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(result.current.data).toEqual(relationships)
			expect(api.relationships.list).toHaveBeenCalledWith('ws-1', undefined)
		})

		it('passes params to API', async () => {
			vi.mocked(api.relationships.list).mockResolvedValue([])
			const params = { source_id: 'o1' }

			const { result } = renderHook(() => useRelationships('ws-1', params), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.relationships.list).toHaveBeenCalledWith('ws-1', params)
		})

		it('handles error', async () => {
			vi.mocked(api.relationships.list).mockRejectedValue(new Error('Failed to fetch'))

			const { result } = renderHook(() => useRelationships('ws-1'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Failed to fetch')
		})
	})

	describe('useObjectRelationships', () => {
		it('returns relationships as source and target', async () => {
			const asSource = [buildRelationship({ id: 'r1', sourceId: 'o1', targetId: 'o2' })]
			const asTarget = [
				buildRelationship({ id: 'r2', sourceId: 'o3', targetId: 'o1', type: 'blocks' }),
			]
			vi.mocked(api.relationships.list)
				.mockResolvedValueOnce(asSource)
				.mockResolvedValueOnce(asTarget)

			const { result } = renderHook(() => useObjectRelationships('ws-1', 'o1'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(result.current.data).toEqual({ asSource, asTarget })
			expect(api.relationships.list).toHaveBeenCalledWith('ws-1', { source_id: 'o1' })
			expect(api.relationships.list).toHaveBeenCalledWith('ws-1', { target_id: 'o1' })
		})

		it('is disabled when objectId is falsy', () => {
			const { result } = renderHook(() => useObjectRelationships('ws-1', ''), {
				wrapper: TestWrapper,
			})

			expect(result.current.isFetching).toBe(false)
			expect(api.relationships.list).not.toHaveBeenCalled()
		})

		it('handles error', async () => {
			vi.mocked(api.relationships.list).mockRejectedValue(new Error('Fetch failed'))

			const { result } = renderHook(() => useObjectRelationships('ws-1', 'o1'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Fetch failed')
		})
	})

	describe('useCreateRelationship', () => {
		it('creates a relationship', async () => {
			const created = buildRelationship()
			vi.mocked(api.relationships.create).mockResolvedValue(created)

			const { result } = renderHook(() => useCreateRelationship('ws-1', 'o1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate({
				source_type: 'bet',
				source_id: 'o1',
				target_type: 'task',
				target_id: 'o2',
				type: 'relates_to',
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.relationships.create).toHaveBeenCalledWith('ws-1', {
				source_type: 'bet',
				source_id: 'o1',
				target_type: 'task',
				target_id: 'o2',
				type: 'relates_to',
			})
		})

		it('handles create error', async () => {
			vi.mocked(api.relationships.create).mockRejectedValue(new Error('Create failed'))

			const { result } = renderHook(() => useCreateRelationship('ws-1', 'o1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate({
				source_type: 'bet',
				source_id: 'o1',
				target_type: 'task',
				target_id: 'o2',
				type: 'relates_to',
			})

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Create failed')
		})
	})

	describe('useDeleteRelationship', () => {
		it('deletes a relationship and shows toast', async () => {
			vi.mocked(api.relationships.delete).mockResolvedValue({ deleted: true })

			const { result } = renderHook(() => useDeleteRelationship('ws-1', 'o1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate('r1')

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.relationships.delete).toHaveBeenCalledWith('r1', 'ws-1')
			expect(toast.success).toHaveBeenCalledWith('Relationship removed')
		})

		it('handles delete error', async () => {
			vi.mocked(api.relationships.delete).mockRejectedValue(new Error('Delete failed'))

			const { result } = renderHook(() => useDeleteRelationship('ws-1', 'o1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate('r1')

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Delete failed')
		})
	})
})
