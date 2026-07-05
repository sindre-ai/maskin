import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import React, { type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		auth: {
			requestEmailChange: vi.fn(),
			cancelEmailChange: vi.fn(),
		},
	},
}))

import { useCancelEmailChange, useRequestEmailChange } from '@/hooks/use-auth'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { buildActorWithKey } from '../factories'

function makeWrapper() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
			mutations: { retry: false },
		},
	})
	const wrapper = ({ children }: { children: ReactNode }) =>
		React.createElement(QueryClientProvider, { client }, children)
	return { client, wrapper }
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useRequestEmailChange', () => {
	it('calls api.auth.requestEmailChange and invalidates the actor detail cache on success', async () => {
		const { client, wrapper } = makeWrapper()
		const actorId = 'actor-1'
		const cached = buildActorWithKey({ id: actorId, pending_email: null })
		client.setQueryData(queryKeys.actors.detail(actorId), cached)
		const invalidate = vi.spyOn(client, 'invalidateQueries')

		vi.mocked(api.auth.requestEmailChange).mockResolvedValue(
			buildActorWithKey({ id: actorId, pending_email: 'new@example.com' }),
		)

		const { result } = renderHook(() => useRequestEmailChange(actorId), { wrapper })

		await act(async () => {
			await result.current.mutateAsync({
				new_email: 'new@example.com',
				current_password: 'pw',
			})
		})

		expect(api.auth.requestEmailChange).toHaveBeenCalledWith({
			new_email: 'new@example.com',
			current_password: 'pw',
		})
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.actors.detail(actorId) })
	})

	it('does not invalidate the cache when the request fails', async () => {
		const { client, wrapper } = makeWrapper()
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		vi.mocked(api.auth.requestEmailChange).mockRejectedValue(new Error('boom'))

		const { result } = renderHook(() => useRequestEmailChange('actor-1'), { wrapper })

		await act(async () => {
			result.current.mutate({ new_email: 'new@example.com', current_password: 'pw' })
		})

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(invalidate).not.toHaveBeenCalled()
	})
})

describe('useCancelEmailChange', () => {
	it('calls api.auth.cancelEmailChange and invalidates the actor detail cache on success', async () => {
		const { client, wrapper } = makeWrapper()
		const actorId = 'actor-2'
		const invalidate = vi.spyOn(client, 'invalidateQueries')

		vi.mocked(api.auth.cancelEmailChange).mockResolvedValue(
			buildActorWithKey({ id: actorId, pending_email: null }),
		)

		const { result } = renderHook(() => useCancelEmailChange(actorId), { wrapper })

		await act(async () => {
			await result.current.mutateAsync()
		})

		expect(api.auth.cancelEmailChange).toHaveBeenCalledWith()
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.actors.detail(actorId) })
	})
})
