import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		sessions: {
			usage: vi.fn(),
		},
	},
}))

import { pickBucket, useSessionUsage } from '@/hooks/use-session-usage'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

describe('pickBucket', () => {
	const now = new Date('2026-05-04T12:00:00Z').getTime()

	it('picks hour for spans under 48 hours', () => {
		expect(pickBucket(now - 12 * 3_600_000, now)).toBe('hour')
		expect(pickBucket(now - 47 * 3_600_000, now)).toBe('hour')
	})

	it('picks day for spans 2–90 days', () => {
		expect(pickBucket(now - 7 * 86_400_000, now)).toBe('day')
		expect(pickBucket(now - 30 * 86_400_000, now)).toBe('day')
	})

	it('picks week for spans over 90 days', () => {
		expect(pickBucket(now - 180 * 86_400_000, now)).toBe('week')
	})
})

describe('useSessionUsage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('calls api.sessions.usage with the derived bucket', async () => {
		const mockResponse = {
			buckets: [],
			totals: { session_count: 0, total_cost_usd: 0, input_tokens: 0, output_tokens: 0 },
		}
		vi.mocked(api.sessions.usage).mockResolvedValue(mockResponse)

		const from = new Date('2026-04-04T00:00:00Z')
		const to = new Date('2026-05-04T00:00:00Z')
		const { result } = renderHook(() => useSessionUsage('ws-1', 'agent-1', from, to), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.sessions.usage).toHaveBeenCalledWith('ws-1', {
			actor_id: 'agent-1',
			from: from.toISOString(),
			to: to.toISOString(),
			bucket: 'day',
		})
	})

	it('does not fetch without a workspaceId or actorId', () => {
		const from = new Date()
		const to = new Date(from.getTime() + 86_400_000)
		renderHook(() => useSessionUsage('', 'agent-1', from, to), { wrapper: TestWrapper })
		expect(api.sessions.usage).not.toHaveBeenCalled()
	})
})
