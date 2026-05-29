import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			userDisplaySettings: {
				list: vi.fn(),
				get: vi.fn(),
				upsert: vi.fn(),
			},
		},
	}
})

import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import { ApiError, type UserDisplaySettingsResponse, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { TestWrapper } from '../setup'

describe('useUserDisplaySettings', () => {
	beforeEach(() => vi.clearAllMocks())

	it('returns the persisted settings row for the object type', async () => {
		const row = {
			object_type: 'task',
			name: 'default',
			settings: { sort: 'title', order: 'asc' as const },
			updated_at: '2026-05-28T10:00:00.000Z',
		}
		vi.mocked(api.userDisplaySettings.get).mockResolvedValue(row)

		const { result } = renderHook(() => useUserDisplaySettings('ws-1', 'task'), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(row)
		expect(api.userDisplaySettings.get).toHaveBeenCalledWith('ws-1', 'task')
	})

	it('returns null when the server has no row yet (404)', async () => {
		vi.mocked(api.userDisplaySettings.get).mockRejectedValue(new ApiError(404, 'not found'))

		const { result } = renderHook(() => useUserDisplaySettings('ws-1', 'task'), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
	})

	it('skips the fetch when objectType is empty', () => {
		vi.mocked(api.userDisplaySettings.get).mockResolvedValue({
			object_type: 'task',
			name: 'default',
			settings: {},
			updated_at: '2026-05-28T10:00:00.000Z',
		})

		const { result } = renderHook(() => useUserDisplaySettings('ws-1', ''), {
			wrapper: TestWrapper,
		})

		expect(result.current.fetchStatus).toBe('idle')
		expect(api.userDisplaySettings.get).not.toHaveBeenCalled()
	})
})

describe('useUpdateUserDisplaySettings', () => {
	beforeEach(() => vi.clearAllMocks())

	it('upserts the settings via the api', async () => {
		const row = {
			object_type: 'task',
			name: 'default',
			settings: { sort: 'created', order: 'desc' as const },
			updated_at: '2026-05-28T11:00:00.000Z',
		}
		vi.mocked(api.userDisplaySettings.upsert).mockResolvedValue(row)

		const { result } = renderHook(() => useUpdateUserDisplaySettings('ws-1'), {
			wrapper: TestWrapper,
		})

		result.current.mutate({ objectType: 'task', settings: row.settings })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.userDisplaySettings.upsert).toHaveBeenCalledWith('ws-1', 'task', row.settings)
	})

	it('rolls the cache back to the previous row when the upsert rejects', async () => {
		// Seed cache with the persisted row so onMutate captures it as `previous`,
		// then make the upsert reject so onError fires. Cache should restore.
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false, gcTime: 1000 * 60 },
				mutations: { retry: false },
			},
		})
		const Wrapper = ({ children }: { children: ReactNode }) =>
			React.createElement(QueryClientProvider, { client: queryClient }, children)

		const previous: UserDisplaySettingsResponse = {
			object_type: 'task',
			name: 'default',
			settings: { sort: 'title', order: 'asc' },
			updated_at: '2026-05-28T10:00:00.000Z',
		}
		const detailKey = queryKeys.userDisplaySettings.detail('ws-1', 'task')
		queryClient.setQueryData(detailKey, previous)

		// Deferred rejection lets us observe the optimistic write before the
		// mutation finishes, then confirm the rollback after it rejects.
		let rejectUpsert!: (err: Error) => void
		vi.mocked(api.userDisplaySettings.upsert).mockReturnValue(
			new Promise((_resolve, reject) => {
				rejectUpsert = reject
			}),
		)

		const { result } = renderHook(() => useUpdateUserDisplaySettings('ws-1'), {
			wrapper: Wrapper,
		})
		const nextSettings = { sort: 'created', order: 'desc' as const }
		result.current.mutate({ objectType: 'task', settings: nextSettings })

		// Optimistic write lands first while the upsert promise is still pending.
		await waitFor(() => {
			const optimistic = queryClient.getQueryData<UserDisplaySettingsResponse>(detailKey)
			expect(optimistic?.settings).toEqual(nextSettings)
		})

		rejectUpsert(new ApiError(500, 'boom'))

		// Once the mutation errors, the cache should be back to `previous`.
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(queryClient.getQueryData<UserDisplaySettingsResponse>(detailKey)).toEqual(previous)
	})
})
