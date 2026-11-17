import {
	PlanLimitBanner,
	PlanLimitComposerGate,
	planLimitCopy,
} from '@/components/billing/plan-limit-banner'
import { useBillingUsage } from '@/hooks/use-billing'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-billing', () => ({
	useBillingUsage: vi.fn(),
	useStripeCheckout: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
	useBillingCancel: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

type Result = ReturnType<typeof useBillingUsage>
const usage = (over: Record<string, unknown>) =>
	vi.mocked(useBillingUsage).mockReturnValue({
		data: {
			plan: 'trial',
			status: 'active',
			usd_cents_used: 286,
			hard_cap_usd_cents: 286,
			credit_balance_cents: 0,
			period_resets_in_ms: 3 * 86_400_000,
			...over,
		},
		isPending: false,
		isError: false,
	} as unknown as Result)

describe('planLimitCopy', () => {
	it('tells a trial it waits until the trial ends, and a paid plan until next month', () => {
		const trial = planLimitCopy({ plan: 'trial', period_resets_in_ms: 86_400_000 })
		expect(trial.banner).toMatch(
			/^You have used 100% of your trial\. New work waits until your trial ends on \d+ \w+, or you can choose a plan now\.$/,
		)
		expect(trial.button).toBe('Choose a plan')
		expect(trial.notice).toBe(
			'Your agents are paused. Your plan is used up. Work starts again when you choose a plan.',
		)

		const paid = planLimitCopy({ plan: 'pro', period_resets_in_ms: 86_400_000 })
		expect(paid.banner).toMatch(
			/^You have used 100% of your Pro plan\. New work waits until \d+ \w+, or you can change plan now\.$/,
		)
		expect(paid.button).toBe('Change plan')
		expect(paid.notice).toMatch(
			/^Your agents are paused\. Your plan is used up\. Work starts again on \d+ \w+, or when you change plan\.$/,
		)
	})

	it('never shows a dollar amount or a token count', () => {
		for (const plan of ['trial', 'pro'] as const) {
			const c = planLimitCopy({ plan, period_resets_in_ms: 86_400_000 })
			expect(`${c.banner} ${c.button} ${c.notice}`).not.toMatch(/\$|token|credit/i)
		}
	})
})

describe('PlanLimitBanner', () => {
	beforeEach(() => vi.clearAllMocks())

	it('shows at 100% with a button that opens the plan picker', () => {
		usage({})
		render(<PlanLimitBanner workspaceId="ws-1" />)
		expect(screen.getByRole('status')).toHaveTextContent('You have used 100% of your trial.')
		fireEvent.click(screen.getByRole('button', { name: 'Choose a plan' }))
		expect(screen.getByRole('dialog')).toBeInTheDocument()
	})

	it.each([
		['under 100%', { usd_cents_used: 200 }],
		['a credit balance still starts work', { credit_balance_cents: 2500, plan: 'pro' }],
		['the period is over (the expired banner owns it)', { period_resets_in_ms: 0 }],
	])('shows nothing when %s', (_name, over) => {
		usage(over)
		render(<PlanLimitBanner workspaceId="ws-1" />)
		expect(screen.queryByRole('status')).not.toBeInTheDocument()
	})
})

describe('PlanLimitComposerGate', () => {
	it('puts the paused notice above the composer and keeps it usable', () => {
		usage({})
		render(
			<PlanLimitComposerGate workspaceId="ws-1" enabled>
				<textarea aria-label="Message" />
			</PlanLimitComposerGate>,
		)
		expect(screen.getByRole('alert')).toHaveTextContent('Your agents are paused.')
		expect(screen.getByLabelText('Message')).not.toBeDisabled()
	})

	it('shows nothing extra with the flag off', () => {
		usage({})
		render(
			<PlanLimitComposerGate workspaceId="ws-1" enabled={false}>
				<textarea aria-label="Message" />
			</PlanLimitComposerGate>,
		)
		expect(screen.queryByRole('alert')).not.toBeInTheDocument()
	})
})
