import { TrialCard } from '@/components/billing/trial-card'
import { useBillingUsage } from '@/hooks/use-billing'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-billing', () => ({ useBillingUsage: vi.fn() }))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const KEY = 'trial-card-absent:ws-1'
type Result = ReturnType<typeof useBillingUsage>
const result = (r: Record<string, unknown>) => r as unknown as Result

describe('TrialCard absent-flag', () => {
	beforeEach(() => {
		localStorage.clear()
	})

	it('writes the flag once usage loads on a paid plan', () => {
		vi.mocked(useBillingUsage).mockReturnValue(
			result({
				data: { plan: 'pro', period_resets_in_ms: 1 },
				isPending: false,
				isSuccess: true,
			}),
		)
		render(<TrialCard workspaceId="ws-1" />)
		expect(localStorage.getItem(KEY)).toBe('1')
	})

	it('does not write the flag after a failed billing fetch', () => {
		vi.mocked(useBillingUsage).mockReturnValue(
			result({ data: undefined, isPending: false, isSuccess: false, isError: true }),
		)
		render(<TrialCard workspaceId="ws-1" />)
		expect(localStorage.getItem(KEY)).toBeNull()
	})

	it('clears the flag when the workspace is on a trial', () => {
		localStorage.setItem(KEY, '1')
		vi.mocked(useBillingUsage).mockReturnValue(
			result({
				data: { plan: 'trial', period_resets_in_ms: 3 * 24 * 60 * 60 * 1000 },
				isPending: false,
				isSuccess: true,
			}),
		)
		render(<TrialCard workspaceId="ws-1" />)
		expect(localStorage.getItem(KEY)).toBeNull()
	})
})
