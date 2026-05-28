import { renderHook, waitFor } from '@testing-library/react'
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
import { ApiError, api } from '@/lib/api'
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
})
