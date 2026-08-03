import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		briefing: {
			latest: vi.fn(),
		},
	},
}))

import { useBriefing } from '@/hooks/use-briefing'
import { api } from '@/lib/api'
import { buildObjectResponse } from '../factories'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useBriefing', () => {
	it('returns the latest briefing payload for a workspace', async () => {
		const payload = {
			object: buildObjectResponse({ id: 'brf-1', type: 'knowledge', title: "Today's briefing" }),
			audioFileId: 'file-abc',
			unreadDelta: 4,
		}
		vi.mocked(api.briefing.latest).mockResolvedValue(payload)

		const { result } = renderHook(() => useBriefing(workspaceId), { wrapper: TestWrapper })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(payload)
		expect(api.briefing.latest).toHaveBeenCalledWith(workspaceId)
	})

	it('returns an empty briefing payload when no briefing exists', async () => {
		vi.mocked(api.briefing.latest).mockResolvedValue({
			object: null,
			audioFileId: null,
			unreadDelta: 0,
		})
		const { result } = renderHook(() => useBriefing(workspaceId), { wrapper: TestWrapper })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data?.object).toBeNull()
	})

	it('is disabled without a workspace id', () => {
		const { result } = renderHook(() => useBriefing(''), { wrapper: TestWrapper })
		expect(result.current.fetchStatus).toBe('idle')
		expect(api.briefing.latest).not.toHaveBeenCalled()
	})
})
