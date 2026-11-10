import { PlanPercentProvider } from '@/components/billing/plan-percent-context'
import { TrialCard } from '@/components/billing/trial-card'
import { useBillingUsage } from '@/hooks/use-billing'
import { render, screen } from '@testing-library/react'
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

describe('TrialCard percent display', () => {
	const trial = (used: number) =>
		vi.mocked(useBillingUsage).mockReturnValue(
			result({
				data: {
					plan: 'trial',
					status: 'active',
					usd_cents_used: used,
					hard_cap_usd_cents: 286,
					credit_balance_cents: 0,
					period_resets_in_ms: 5 * 24 * 60 * 60 * 1000,
				},
				isPending: false,
				isSuccess: true,
			}),
		)

	beforeEach(() => localStorage.clear())

	it('shows the percent and a meter in the colour for its range when the flag is on', () => {
		trial(120)
		render(
			<PlanPercentProvider value>
				<TrialCard workspaceId="ws-1" />
			</PlanPercentProvider>,
		)
		expect(screen.getByText('41% of plan used')).toBeInTheDocument()
		const meter = screen.getByRole('progressbar', { name: 'Plan usage' })
		expect(meter).toHaveAttribute('aria-valuenow', '41')
		expect(meter.firstElementChild).toHaveClass('bg-primary')
	})

	it('turns the meter to the warning colour from 80%', () => {
		trial(240)
		render(
			<PlanPercentProvider value>
				<TrialCard workspaceId="ws-1" />
			</PlanPercentProvider>,
		)
		expect(screen.getByText('83% of plan used')).toBeInTheDocument()
		expect(screen.getByRole('progressbar').firstElementChild).toHaveClass('bg-warning')
	})

	it('shows the error colour at 100%', () => {
		trial(300)
		render(
			<PlanPercentProvider value>
				<TrialCard workspaceId="ws-1" />
			</PlanPercentProvider>,
		)
		expect(screen.getByText('100% of plan used')).toBeInTheDocument()
		expect(screen.getByRole('progressbar').firstElementChild).toHaveClass('bg-error')
	})

	it('shows no meter with the flag off', () => {
		trial(120)
		render(<TrialCard workspaceId="ws-1" />)
		expect(screen.getByText('5 days left')).toBeInTheDocument()
		expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
	})
})
