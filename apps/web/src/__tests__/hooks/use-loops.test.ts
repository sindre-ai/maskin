import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		loops: {
			list: vi.fn(),
		},
	},
}))

import { useLoops } from '@/hooks/use-loops'
import { type LoopSummary, api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

function buildLoop(overrides: Partial<LoopSummary> = {}): LoopSummary {
	return {
		id: 'loop-1',
		workspaceId,
		name: 'Customer feedback',
		guarantee: 'Every customer who gives feedback hears back within 30 days',
		status: 'running',
		pill: 'running',
		entryCondition: null,
		closeCondition: null,
		humanDecisionPoints: null,
		inProgressCount: 3,
		closedCount: 128,
		medianTimeToCloseMs: 11 * 24 * 3600 * 1000,
		agentIds: [],
		waitingOnViewer: false,
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: '2026-08-04T00:00:00.000Z',
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useLoops', () => {
	it('unwraps loops from the list-response envelope', async () => {
		const loops = [buildLoop(), buildLoop({ id: 'loop-2', name: 'Build pipeline' })]
		vi.mocked(api.loops.list).mockResolvedValue({ loops })

		const { result } = renderHook(() => useLoops(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(loops)
		expect(api.loops.list).toHaveBeenCalledWith(workspaceId)
	})

	it('returns an empty array when no loops exist', async () => {
		vi.mocked(api.loops.list).mockResolvedValue({ loops: [] })

		const { result } = renderHook(() => useLoops(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual([])
	})

	it('exposes error when API rejects', async () => {
		vi.mocked(api.loops.list).mockRejectedValue(new Error('Network error'))

		const { result } = renderHook(() => useLoops(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Network error')
	})
})
