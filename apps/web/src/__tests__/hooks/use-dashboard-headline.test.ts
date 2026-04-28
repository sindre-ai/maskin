import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		workspaces: {
			headline: vi.fn(),
		},
	},
}))

import { useDashboardHeadline } from '@/hooks/use-dashboard-headline'
import { api } from '@/lib/api'
import type { HeadlineResponse } from '@maskin/shared'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'
const fallbackInput = {
	runningSessions: 0,
	pendingNotifications: 0,
	eventsLast24h: 0,
	uniqueAgentsLast24h: 0,
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useDashboardHeadline', () => {
	it('returns the local rule-based fallback synchronously while loading', () => {
		vi.mocked(api.workspaces.headline).mockReturnValue(new Promise(() => {}))

		const { result } = renderHook(() => useDashboardHeadline(workspaceId, fallbackInput), {
			wrapper: TestWrapper,
		})

		expect(result.current.headline.headline).toBe(
			'The team is at rest — no agents are working and nothing needs your call.',
		)
		expect(result.current.headline.source).toBe('fallback')
		expect(result.current.isLoading).toBe(true)
	})

	it('returns the API response once it resolves', async () => {
		const apiResponse: HeadlineResponse = {
			headline: 'Three agents are shipping.',
			generatedAt: '2026-04-26T10:00:00.000Z',
			source: 'llm',
		}
		vi.mocked(api.workspaces.headline).mockResolvedValue(apiResponse)

		const { result } = renderHook(() => useDashboardHeadline(workspaceId, fallbackInput), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isLoading).toBe(false))
		expect(result.current.headline).toEqual(apiResponse)
	})

	it('keeps showing the local fallback when the API call rejects', async () => {
		vi.mocked(api.workspaces.headline).mockRejectedValue(new Error('Network down'))

		const { result } = renderHook(
			() =>
				useDashboardHeadline(workspaceId, {
					runningSessions: 1,
					pendingNotifications: 0,
					eventsLast24h: 0,
					uniqueAgentsLast24h: 0,
				}),
			{ wrapper: TestWrapper },
		)

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.headline.headline).toBe(
			'1 agent is shipping work — nothing needs your call right now.',
		)
		expect(result.current.headline.source).toBe('fallback')
	})

	it('does not call the API when workspaceId is empty', () => {
		const { result } = renderHook(() => useDashboardHeadline('', fallbackInput), {
			wrapper: TestWrapper,
		})

		expect(api.workspaces.headline).not.toHaveBeenCalled()
		expect(result.current.headline.headline).toBe(
			'The team is at rest — no agents are working and nothing needs your call.',
		)
	})
})
