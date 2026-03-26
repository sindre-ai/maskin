import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		events: {
			history: vi.fn(),
			create: vi.fn(),
		},
	},
}))

import { useCreateComment, useEntityEvents, useEvents } from '@/hooks/use-events'
import type { EventResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

function buildEvent(overrides: Partial<EventResponse> & { id: number }): EventResponse {
	return {
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		action: 'created',
		entityType: 'object',
		entityId: 'obj-1',
		data: null,
		createdAt: null,
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useEvents', () => {
	it('fetches events for workspace', async () => {
		const mockEvents = [
			buildEvent({ id: 1, action: 'created' }),
			buildEvent({ id: 2, action: 'updated' }),
		]
		vi.mocked(api.events.history).mockResolvedValue(mockEvents)

		const { result } = renderHook(() => useEvents(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockEvents)
		expect(api.events.history).toHaveBeenCalledWith(workspaceId, undefined)
	})

	it('passes filters to API call', async () => {
		vi.mocked(api.events.history).mockResolvedValue([])
		const filters = { entity_type: 'object', limit: '10' }

		const { result } = renderHook(() => useEvents(workspaceId, filters), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.events.history).toHaveBeenCalledWith(workspaceId, filters)
	})

	it('exposes error when API rejects', async () => {
		vi.mocked(api.events.history).mockRejectedValue(new Error('Network error'))

		const { result } = renderHook(() => useEvents(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error).toBeInstanceOf(Error)
		expect(result.current.error?.message).toBe('Network error')
	})
})

describe('useEntityEvents', () => {
	it('fetches events for entity', async () => {
		const mockEvents = [buildEvent({ id: 1, entityId: 'obj-1' })]
		vi.mocked(api.events.history).mockResolvedValue(mockEvents)

		const { result } = renderHook(() => useEntityEvents(workspaceId, 'obj-1'), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockEvents)
		expect(api.events.history).toHaveBeenCalledWith(workspaceId, {
			entity_id: 'obj-1',
			limit: '50',
		})
	})

	it('is not enabled when entityId is empty', async () => {
		const { result } = renderHook(() => useEntityEvents(workspaceId, ''), {
			wrapper: TestWrapper,
		})

		expect(result.current.isFetching).toBe(false)
		expect(api.events.history).not.toHaveBeenCalled()
	})

	it('exposes error when API rejects', async () => {
		vi.mocked(api.events.history).mockRejectedValue(new Error('Server error'))

		const { result } = renderHook(() => useEntityEvents(workspaceId, 'obj-1'), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Server error')
	})
})

describe('useCreateComment', () => {
	it('calls api.events.create with workspace and data', async () => {
		const newEvent = buildEvent({ id: 3, action: 'commented', entityId: 'obj-1' })
		vi.mocked(api.events.create).mockResolvedValue(newEvent)

		const { result } = renderHook(() => useCreateComment(workspaceId, 'obj-1'), {
			wrapper: TestWrapper,
		})

		result.current.mutate({ entity_id: 'obj-1', content: 'Nice work!' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.events.create).toHaveBeenCalledWith(workspaceId, {
			entity_id: 'obj-1',
			content: 'Nice work!',
		})
	})

	it('exposes error when create fails', async () => {
		vi.mocked(api.events.create).mockRejectedValue(new Error('Forbidden'))

		const { result } = renderHook(() => useCreateComment(workspaceId, 'obj-1'), {
			wrapper: TestWrapper,
		})

		result.current.mutate({ entity_id: 'obj-1', content: 'Bad' })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Forbidden')
	})
})
