// 1_000 / 2_000 / 20_000 (USD cents) below mirror TRIAL_HARD_CAP_DEFAULT_USD_CENTS /
// PRO_HARD_CAP_DEFAULT_USD_CENTS / TEAM_HARD_CAP_DEFAULT_USD_CENTS in
// apps/dev/src/lib/billing-defaults.ts and the .env.example
// MASKIN_*_HARD_CAP_USD_CENTS defaults. Keep in sync when bumping.
import {
	BillingSection,
	formatCredits,
	formatResetsIn,
} from '@/components/settings/billing-section'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', () => ({
	api: {
		billing: {
			usage: vi.fn(),
			checkout: vi.fn(),
			buyCredits: vi.fn(),
		},
	},
}))

import { api } from '@/lib/api'

const baseUsage = {
	plan: 'trial' as const,
	status: 'active' as const,
	usd_cents_used: 0,
	hard_cap_usd_cents: 1_000,
	period_start: null,
	period_resets_in_ms: 30 * 24 * 60 * 60 * 1000,
	stripe_customer_id: null,
	stripe_subscription_id: null,
	credit_balance_cents: 0,
}

describe('formatCredits', () => {
	it('renders cents as a dollar amount', () => {
		expect(formatCredits(0)).toBe('$0.00')
		expect(formatCredits(125)).toBe('$1.25')
		expect(formatCredits(2_000)).toBe('$20.00')
	})
})

describe('formatResetsIn', () => {
	it('returns days when more than 24h remain', () => {
		expect(formatResetsIn(5 * 24 * 60 * 60 * 1000)).toBe('resets in 5d')
	})
	it('returns empty when under a day (sub-day uses PeriodCountdown instead)', () => {
		expect(formatResetsIn(3 * 60 * 60 * 1000)).toBe('')
	})
	it('returns empty when null or zero', () => {
		expect(formatResetsIn(null)).toBe('')
		expect(formatResetsIn(0)).toBe('')
	})
})

describe('BillingSection', () => {
	beforeEach(() => {
		vi.mocked(api.billing.usage).mockReset()
		vi.mocked(api.billing.checkout).mockReset()
	})

	it('renders trial plan with both upgrade buttons and the usage line', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			usd_cents_used: 125,
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" enterprise />
			</TestWrapper>,
		)

		await screen.findByText('Trial')
		expect(screen.getByText('$1.25 / $10.00 used')).toBeInTheDocument()
		// Trial (non-paid-active) plans start with the comparison grid expanded.
		expect(screen.getByRole('button', { name: 'Upgrade to Pro' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Upgrade to Team' })).toBeInTheDocument()
		expect(
			screen.queryByRole('button', { name: /Switch to bring-your-own/ }),
		).not.toBeInTheDocument()
	})

	it('renders Pro plan with Team upgrade + Switch-to-BYO + Manage in Stripe', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'pro',
			status: 'active',
			usd_cents_used: 750,
			hard_cap_usd_cents: 2_000,
			period_start: Date.now() - 7 * 24 * 60 * 60 * 1000,
			period_resets_in_ms: 23 * 24 * 60 * 60 * 1000,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" enterprise />
			</TestWrapper>,
		)

		await screen.findByText('Pro — $20/mo')
		expect(screen.getByText(/\$7\.50 \/ \$20\.00 used/)).toBeInTheDocument()
		expect(screen.getByText(/resets in 23d/)).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Manage in Stripe/ })).toBeInTheDocument()

		// Paid+active plans start with the comparison grid collapsed.
		expect(screen.queryByRole('button', { name: 'Upgrade to Team' })).not.toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Compare plans' }))

		expect(screen.getByRole('button', { name: 'Upgrade to Team' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Downgrade to Free' })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Upgrade to Pro' })).not.toBeInTheDocument()
	})

	it('renders Team plan with Switch-to-BYO but no further upgrade', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'team',
			status: 'active',
			hard_cap_usd_cents: 20_000,
			usd_cents_used: 100,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" enterprise />
			</TestWrapper>,
		)

		await screen.findByText('Team — $200/mo')
		await user.click(screen.getByRole('button', { name: 'Compare plans' }))

		expect(screen.queryByRole('button', { name: /Upgrade/ })).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Downgrade to Free' })).toBeInTheDocument()
	})

	it('renders BYO plan with the upgrade options + no usage bar', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'enterprise',
			status: 'canceled',
			hard_cap_usd_cents: null,
			period_resets_in_ms: null,
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" enterprise />
			</TestWrapper>,
		)

		await screen.findByText('Enterprise')
		expect(screen.getByText(/Using your own Claude subscription/)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Upgrade to Pro' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Upgrade to Team' })).toBeInTheDocument()
		expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
	})

	it('marks Enterprise as the current plan for an active BYO workspace, not Trial', async () => {
		// The shape `GET /api/billing/usage` now returns for a enterprise-entitled
		// workspace that never connected a BYO credential: plan enterprise, status
		// active (the stored default). Previously the endpoint reported `trial`
		// here, which put "Current plan" on the Trial card and offered the
		// entitled workspace paid upgrades it has no use for.
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'enterprise',
			status: 'active',
			period_resets_in_ms: null,
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" enterprise />
			</TestWrapper>,
		)

		await screen.findByText('Enterprise')
		// Exactly one "Current plan" button, and it belongs to the Enterprise card.
		const current = screen.getAllByRole('button', { name: 'Current plan' })
		expect(current).toHaveLength(1)
		// `closest('div')` is the PlanCard root — the button is its direct child.
		const currentCard = current[0].closest('div')
		expect(currentCard?.textContent).toContain('ENTERPRISE')
		expect(currentCard?.textContent).not.toContain('TRIAL')
		expect(screen.queryByRole('button', { name: 'Upgrade to Pro' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Upgrade to Team' })).not.toBeInTheDocument()
		expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
	})

	it('redirects to Stripe checkout url on upgrade click', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.usage).mockResolvedValue(baseUsage)
		vi.mocked(api.billing.checkout).mockResolvedValue({
			url: 'https://checkout.stripe.com/c/cs_test_1',
			session_id: 'cs_test_1',
		})

		const original = window.location
		// jsdom's Location object is read-only; replace it with a writable stand-in
		// so the component's `window.location.href = url` doesn't blow up.
		Object.defineProperty(window, 'location', {
			writable: true,
			value: { ...original, href: 'http://localhost/settings/keys', assign: vi.fn() },
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" enterprise />
			</TestWrapper>,
		)

		await user.click(await screen.findByRole('button', { name: 'Upgrade to Pro' }))

		await vi.waitFor(() => {
			expect(api.billing.checkout).toHaveBeenCalledWith(
				'ws-1',
				expect.objectContaining({ plan: 'pro' }),
			)
		})
		await vi.waitFor(() => {
			expect(window.location.href).toBe('https://checkout.stripe.com/c/cs_test_1')
		})

		Object.defineProperty(window, 'location', { writable: true, value: original })
	})

	it('opens the Switch-to-BYO dialog on click and explains the BYO flow', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'pro',
			hard_cap_usd_cents: 2_000,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" enterprise />
			</TestWrapper>,
		)

		await screen.findByText('Pro — $20/mo')
		await user.click(screen.getByRole('button', { name: 'Compare plans' }))
		await user.click(screen.getByRole('button', { name: 'Downgrade to Free' }))
		expect(screen.getByRole('dialog')).toBeInTheDocument()
		expect(screen.getByText(/lose access to Maskin's hosted LLM/)).toBeInTheDocument()
	})

	it('shows Cancel subscription (not Downgrade to Free) on the Trial card when enterprise is false', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: 2_000,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" enterprise={false} />
			</TestWrapper>,
		)

		await screen.findByText('Pro — $20/mo')
		await user.click(screen.getByRole('button', { name: 'Compare plans' }))

		expect(screen.queryByRole('button', { name: 'Downgrade to Free' })).not.toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Cancel subscription' }))
		expect(screen.getByRole('dialog')).toBeInTheDocument()
		expect(screen.getByText(/go back to the free trial plan/)).toBeInTheDocument()
	})

	it('shows a disabled "Current plan" button on the plan card matching the active plan', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			usd_cents_used: 125,
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" enterprise />
			</TestWrapper>,
		)

		await screen.findByText('Trial')
		const currentPlanButton = screen.getByRole('button', { name: 'Current plan' })
		expect(currentPlanButton).toBeDisabled()
	})

	it('shows the credit balance and Buy usage credits button, non-alarming bar with a balance available', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: 2_000,
			usd_cents_used: 2_500,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
			credit_balance_cents: 4_000,
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" enterprise />
			</TestWrapper>,
		)

		await screen.findByText('Pro — $20/mo')
		expect(screen.getByText('$40.00 usage credits')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Buy usage credits' })).toBeInTheDocument()
		// A spendable balance is expected, already-paid-for usage — the bar must not read as an error.
		const bar = screen.getByRole('progressbar')
		expect(bar.className).not.toContain('bg-error')
	})

	it('shows the hard-blocked (error) bar when over cap with a zero credit balance', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: 2_000,
			usd_cents_used: 2_500,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
			credit_balance_cents: 0,
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" enterprise />
			</TestWrapper>,
		)

		await screen.findByText('Pro — $20/mo')
		expect(screen.getByText('$0.00 usage credits')).toBeInTheDocument()
		const bar = screen.getByRole('progressbar')
		expect(bar.className).toContain('bg-error')
	})

	it('buys usage credits and redirects to the Stripe checkout url', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: 2_000,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
			credit_balance_cents: 0,
		})
		vi.mocked(api.billing.buyCredits).mockResolvedValue({
			url: 'https://checkout.stripe.com/c/cs_credit_1',
			session_id: 'cs_credit_1',
		})

		const original = window.location
		Object.defineProperty(window, 'location', {
			writable: true,
			value: { ...original, href: 'http://localhost/settings/keys', assign: vi.fn() },
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" enterprise />
			</TestWrapper>,
		)

		await screen.findByText('Pro — $20/mo')
		await user.click(screen.getByRole('button', { name: 'Buy usage credits' }))
		expect(await screen.findByRole('dialog')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: '$25' }))
		await user.click(screen.getByRole('button', { name: 'Buy $25' }))

		await vi.waitFor(() => {
			expect(api.billing.buyCredits).toHaveBeenCalledWith(
				'ws-1',
				expect.objectContaining({ amount_usd_cents: 2_500 }),
			)
		})
		await vi.waitFor(() => {
			expect(window.location.href).toBe('https://checkout.stripe.com/c/cs_credit_1')
		})

		Object.defineProperty(window, 'location', { writable: true, value: original })
	})

	it('toggles the plan comparison grid via Compare plans / Hide plans', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: 2_000,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" enterprise />
			</TestWrapper>,
		)

		await screen.findByText('Pro — $20/mo')
		expect(screen.queryByRole('button', { name: 'Downgrade to Free' })).not.toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Compare plans' }))
		expect(screen.getByRole('button', { name: 'Downgrade to Free' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Hide plans' })).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Hide plans' }))
		expect(screen.queryByRole('button', { name: 'Downgrade to Free' })).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Compare plans' })).toBeInTheDocument()
	})
})
