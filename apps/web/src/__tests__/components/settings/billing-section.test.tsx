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
	hard_cap_tokens: 100_000,
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
	it('returns hours when under a day', () => {
		expect(formatResetsIn(3 * 60 * 60 * 1000)).toBe('resets in 3h')
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
				<BillingSection workspaceId="ws-1" />
			</TestWrapper>,
		)

		await screen.findByText('Trial')
		expect(screen.getByText('25k / 100k tokens')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Upgrade to Starter' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Upgrade to Pro' })).toBeInTheDocument()
		expect(
			screen.queryByRole('button', { name: /Switch to bring-your-own/ }),
		).not.toBeInTheDocument()
	})

	it('renders Starter plan with Pro upgrade + Switch-to-BYO + Manage in Stripe', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'starter',
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
				<BillingSection workspaceId="ws-1" />
			</TestWrapper>,
		)

		await screen.findByText('Starter — $20/mo')
		expect(screen.getByText(/12M \/ 32M tokens/)).toBeInTheDocument()
		expect(screen.getByText(/resets in 23d/)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Upgrade to Pro' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Switch to bring-your-own/ })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Manage in Stripe/ })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Upgrade to Starter' })).not.toBeInTheDocument()
	})

	it('renders Fix payment alone on Starter + past_due — no Upgrade CTAs', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'starter',
			status: 'past_due',
			tokens_used: 12_000_000,
			hard_cap_tokens: 32_000_000,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" />
			</TestWrapper>,
		)

		await screen.findByText('Starter — $20/mo')
		const fix = screen.getByRole('link', { name: 'Fix payment' })
		expect(fix).toBeInTheDocument()
		expect(fix).toHaveAttribute('href', expect.stringContaining('billing.stripe.com'))
		expect(screen.queryByRole('button', { name: 'Upgrade to Starter' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Upgrade to Pro' })).not.toBeInTheDocument()
		expect(
			screen.queryByRole('button', { name: /Switch to bring-your-own/ }),
		).not.toBeInTheDocument()
	})

	it('renders Fix payment alone on Starter + incomplete — no Upgrade CTAs', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'starter',
			status: 'incomplete',
			tokens_used: 0,
			hard_cap_tokens: 32_000_000,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" />
			</TestWrapper>,
		)

		await screen.findByText('Starter — $20/mo')
		expect(screen.getByRole('link', { name: 'Fix payment' })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Upgrade to Starter' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Upgrade to Pro' })).not.toBeInTheDocument()
	})

	it('renders Pro plan with Switch-to-BYO but no further upgrade', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'pro',
			status: 'active',
			hard_cap_tokens: 96_000_000,
			tokens_used: 1_000_000,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" />
			</TestWrapper>,
		)

		await screen.findByText('Pro — $60/mo')
		expect(screen.queryByRole('button', { name: /Upgrade/ })).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Switch to bring-your-own/ })).toBeInTheDocument()
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
				<BillingSection workspaceId="ws-1" />
			</TestWrapper>,
		)

		await screen.findByText('Bring-your-own')
		expect(screen.getByText(/Using your own Claude subscription/)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Upgrade to Starter' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Upgrade to Pro' })).toBeInTheDocument()
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
				<BillingSection workspaceId="ws-1" />
			</TestWrapper>,
		)

		await user.click(await screen.findByRole('button', { name: 'Upgrade to Starter' }))

		await vi.waitFor(() => {
			expect(api.billing.checkout).toHaveBeenCalledWith(
				'ws-1',
				expect.objectContaining({ plan: 'starter' }),
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
			plan: 'starter',
			hard_cap_tokens: 32_000_000,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})

		render(
			<TestWrapper>
				<BillingSection workspaceId="ws-1" />
			</TestWrapper>,
		)

		await user.click(await screen.findByRole('button', { name: /Switch to bring-your-own/ }))
		expect(screen.getByRole('dialog')).toBeInTheDocument()
		expect(screen.getByText(/cancels your active Maskin subscription/)).toBeInTheDocument()
	})
})
