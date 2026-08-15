import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		objects: {
			list: vi.fn(),
		},
	},
}))

import { useIsSignupWorkspace, useSignupDraftBet } from '@/hooks/use-signup-first-bet'
import { api } from '@/lib/api'
import { buildObjectResponse } from '../factories'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useSignupDraftBet', () => {
	it('queries with the signup_first_bet_draft metadata filter', async () => {
		vi.mocked(api.objects.list).mockResolvedValue([])

		const { result } = renderHook(() => useSignupDraftBet(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.objects.list).toHaveBeenCalledWith(workspaceId, {
			type: 'bet',
			status: 'qualified',
			'metadata.source': 'signup_first_bet_draft',
		})
		expect(result.current.bet).toBeNull()
	})

	it('returns the most recent qualified signup_first_bet_draft bet', async () => {
		const older = buildObjectResponse({
			id: 'bet-old',
			type: 'bet',
			status: 'qualified',
			createdAt: '2026-08-01T00:00:00Z',
			metadata: { source: 'signup_first_bet_draft' },
		})
		const newer = buildObjectResponse({
			id: 'bet-new',
			type: 'bet',
			status: 'qualified',
			createdAt: '2026-08-14T00:00:00Z',
			metadata: { source: 'signup_first_bet_draft' },
		})
		vi.mocked(api.objects.list).mockResolvedValue([older, newer])

		const { result } = renderHook(() => useSignupDraftBet(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.bet).not.toBeNull())
		expect(result.current.bet?.id).toBe('bet-new')
	})
})

describe('useIsSignupWorkspace', () => {
	it('queries knowledge objects with metadata.source=signup_capture', async () => {
		vi.mocked(api.objects.list).mockResolvedValue([])

		const { result } = renderHook(() => useIsSignupWorkspace(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.objects.list).toHaveBeenCalledWith(workspaceId, {
			type: 'knowledge',
			'metadata.source': 'signup_capture',
		})
		expect(result.current.isSignup).toBe(false)
	})

	it('reports isSignup=true when a signup_capture knowledge object exists', async () => {
		vi.mocked(api.objects.list).mockResolvedValue([
			buildObjectResponse({ type: 'knowledge', metadata: { source: 'signup_capture' } }),
		])

		const { result } = renderHook(() => useIsSignupWorkspace(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSignup).toBe(true))
	})
})
