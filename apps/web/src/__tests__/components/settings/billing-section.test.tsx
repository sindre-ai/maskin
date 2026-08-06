// 8_000_000 / 32_000_000 / 320_000_000 below mirror TRIAL_HARD_CAP_DEFAULT_TOKENS /
// PRO_HARD_CAP_DEFAULT_TOKENS / TEAM_HARD_CAP_DEFAULT_TOKENS in
// apps/dev/src/lib/billing-defaults.ts and the .env.example
// MASKIN_*_HARD_CAP_TOKENS defaults. Keep in sync when bumping.
import { BillingSection, formatResetsIn, formatTokens } from '@/components/settings/billing-section'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', () => ({
	api: {
		billing: {
			usage: vi.fn(),
			checkout: vi.fn(),
		},
	},
}))

import { api } from '@/lib/api'

const baseUsage = {
	plan: 'trial' as const,
	status: 'active' as const,
	tokens_used: 0,
	hard_cap_tokens: 8_000_000,
	period_start: null,
	period_resets_in_ms: 30 * 24 * 60 * 60 * 1000,
	stripe_customer_id: null,
	stripe_subscription_id: null,
}

describe('formatTokens', () => {
	it('renders raw numbers under 1k', () => {
		expect(formatTokens(0)).toBe('0')
		expect(formatTokens(999)).toBe('999')
	})
	it('uses k for thousands', () => {
		expect(formatTokens(1_500)).toBe('1.5k')
		expect(formatTokens(12_000)).toBe('12k')
	})
	it('uses M for millions', () => {
		expect(formatTokens(1_500_000)).toBe('1.5M')
		expect(formatTokens(32_000_000)).toBe('32M')
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
			tokens_used: 25_000,
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" byollmAllowed />
			</TestWrapper>,
		)

		await screen.findByText('Trial')
		expect(screen.getByText('25k / 8.0M tokens')).toBeInTheDocument()
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
			tokens_used: 12_000_000,
			hard_cap_tokens: 32_000_000,
			period_start: Date.now() - 7 * 24 * 60 * 60 * 1000,
			period_resets_in_ms: 23 * 24 * 60 * 60 * 1000,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" byollmAllowed />
			</TestWrapper>,
		)

		await screen.findByText('Pro — $20/mo')
		expect(screen.getByText(/12M \/ 32M tokens/)).toBeInTheDocument()
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
			hard_cap_tokens: 320_000_000,
			tokens_used: 1_000_000,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" byollmAllowed />
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
			plan: 'byollm',
			status: 'canceled',
			hard_cap_tokens: null,
			period_resets_in_ms: null,
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" byollmAllowed />
			</TestWrapper>,
		)

		await screen.findByText('Enterprise')
		expect(screen.getByText(/Using your own Claude subscription/)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Upgrade to Pro' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Upgrade to Team' })).toBeInTheDocument()
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
				<BillingSection workspaceId="ws-1" byollmAllowed />
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
			hard_cap_tokens: 32_000_000,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" byollmAllowed />
			</TestWrapper>,
		)

		await screen.findByText('Pro — $20/mo')
		await user.click(screen.getByRole('button', { name: 'Compare plans' }))
		await user.click(screen.getByRole('button', { name: 'Downgrade to Free' }))
		expect(screen.getByRole('dialog')).toBeInTheDocument()
		expect(screen.getByText(/lose access to Maskin's hosted LLM/)).toBeInTheDocument()
	})

	it('shows Cancel subscription (not Downgrade to Free) on the Trial card when byollmAllowed is false', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'pro',
			status: 'active',
			hard_cap_tokens: 32_000_000,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" byollmAllowed={false} />
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
			tokens_used: 25_000,
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" byollmAllowed />
			</TestWrapper>,
		)

		await screen.findByText('Trial')
		const currentPlanButton = screen.getByRole('button', { name: 'Current plan' })
		expect(currentPlanButton).toBeDisabled()
	})

	it('toggles the plan comparison grid via Compare plans / Hide plans', async () => {
		const user = userEvent.setup()
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'pro',
			status: 'active',
			hard_cap_tokens: 32_000_000,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" byollmAllowed />
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
