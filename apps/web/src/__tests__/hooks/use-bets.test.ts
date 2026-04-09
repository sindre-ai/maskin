import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		objects: {
			list: vi.fn(),
		},
	},
}))

import { useBets } from '@/hooks/use-bets'
import { api } from '@/lib/api'
import { buildObjectResponse } from '../factories'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useBets', () => {
	it('fetches bets for workspace', async () => {
		const mockBets = [
			buildObjectResponse({ id: 'bet-1', type: 'bet', title: 'Bet A' }),
			buildObjectResponse({ id: 'bet-2', type: 'bet', title: 'Bet B' }),
		]
		vi.mocked(api.objects.list).mockResolvedValue({
			data: mockBets,
			total: mockBets.length,
			limit: 50,
			offset: 0,
		})

		const { result } = renderHook(() => useBets(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockBets)
		expect(api.objects.list).toHaveBeenCalledWith(workspaceId, { type: 'bet' })
	})

	it('exposes error when API rejects', async () => {
		vi.mocked(api.objects.list).mockRejectedValue(new Error('Network error'))

		const { result } = renderHook(() => useBets(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error).toBeInstanceOf(Error)
		expect(result.current.error?.message).toBe('Network error')
	})

	it('returns empty array when no bets exist', async () => {
		vi.mocked(api.objects.list).mockResolvedValue({
			data: [],
			total: 0,
			limit: 50,
			offset: 0,
		})

		const { result } = renderHook(() => useBets(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual([])
	})
})
