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
import type { ObjectResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

function buildBet(overrides: Partial<ObjectResponse> & { id: string }): ObjectResponse {
	return {
		workspaceId: 'ws-1',
		type: 'bet',
		title: 'Test Bet',
		content: null,
		status: 'active',
		metadata: null,
		owner: null,
		activeSessionId: null,
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useBets', () => {
	it('fetches bets for workspace', async () => {
		const mockBets = [
			buildBet({ id: 'bet-1', title: 'Bet A' }),
			buildBet({ id: 'bet-2', title: 'Bet B' }),
		]
		vi.mocked(api.objects.list).mockResolvedValue(mockBets)

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
		vi.mocked(api.objects.list).mockResolvedValue([])

		const { result } = renderHook(() => useBets(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual([])
	})
})
