import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		sessions: { logs: vi.fn() },
	},
}))

import { useSessionActivityLogs } from '@/hooks/use-session-activity-logs'
import { api } from '@/lib/api'
import type { SessionLogResponse } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'
const sessionId = '11111111-1111-1111-1111-111111111111'

function buildLog(id: number, content = `line ${id}`): SessionLogResponse {
	return {
		id,
		sessionId,
		stream: 'stdout',
		content,
		createdAt: new Date(id).toISOString(),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useSessionActivityLogs', () => {
	it('hydrates from the tail of a long-lived session, not the head', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValue([buildLog(900), buildLog(901)])

		const { result } = renderHook(() => useSessionActivityLogs(workspaceId, [sessionId]), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current[0]?.data).toHaveLength(2))

		// The first request must ask for the newest page. Without this an
		// interactive chat session past the row limit stays pinned to the
		// start of the conversation and the live turn never renders.
		expect(api.sessions.logs).toHaveBeenCalledWith(
			sessionId,
			workspaceId,
			expect.objectContaining({ order: 'desc' }),
		)
	})

	it('pages forward from a since cursor and appends', async () => {
		vi.mocked(api.sessions.logs)
			.mockResolvedValueOnce([buildLog(1), buildLog(2)])
			.mockResolvedValue([buildLog(3)])

		const { result } = renderHook(() => useSessionActivityLogs(workspaceId, [sessionId]), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current[0]?.data).toHaveLength(2))

		await result.current[0]?.refetch?.()

		await waitFor(() => expect(result.current[0]?.data).toHaveLength(3))
		expect(result.current[0]?.data?.map((l) => l.id)).toEqual([1, 2, 3])
		expect(api.sessions.logs).toHaveBeenLastCalledWith(
			sessionId,
			workspaceId,
			expect.objectContaining({ since: '2' }),
		)
	})

	it('does not duplicate rows when a page overlaps what is already held', async () => {
		vi.mocked(api.sessions.logs)
			.mockResolvedValueOnce([buildLog(1), buildLog(2)])
			.mockResolvedValue([buildLog(2), buildLog(3)])

		const { result } = renderHook(() => useSessionActivityLogs(workspaceId, [sessionId]), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current[0]?.data).toHaveLength(2))
		await result.current[0]?.refetch?.()

		await waitFor(() => expect(result.current[0]?.data).toHaveLength(3))
		expect(result.current[0]?.data?.map((l) => l.id)).toEqual([1, 2, 3])
	})
})
