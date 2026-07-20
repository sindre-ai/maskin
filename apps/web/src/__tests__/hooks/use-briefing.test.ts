import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		briefing: {
			get: vi.fn(),
		},
	},
}))

import { useBriefing } from '@/hooks/use-briefing'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useBriefing', () => {
	it('fetches the briefing for a workspace', async () => {
		vi.mocked(api.briefing.get).mockResolvedValue({
			workspace_id: workspaceId,
			markdown: '# Test\n\n## Loops\n\n- **A loop**',
		})

		const { result } = renderHook(() => useBriefing(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data?.markdown).toContain('## Loops')
		expect(api.briefing.get).toHaveBeenCalledWith(workspaceId)
	})

	it('is disabled when workspaceId is empty', () => {
		const { result } = renderHook(() => useBriefing(''), { wrapper: TestWrapper })
		expect(result.current.isFetching).toBe(false)
		expect(api.briefing.get).not.toHaveBeenCalled()
	})

	it('exposes errors', async () => {
		vi.mocked(api.briefing.get).mockRejectedValue(new Error('boom'))
		const { result } = renderHook(() => useBriefing(workspaceId), { wrapper: TestWrapper })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('boom')
	})
})
