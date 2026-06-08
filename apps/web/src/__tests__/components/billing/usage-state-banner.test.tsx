import { UsageStateBanner } from '@/components/billing/usage-state-banner'
import { render, screen } from '@testing-library/react'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', () => ({
	api: {
		billing: {
			usage: vi.fn(),
		},
	},
}))

vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		params,
		to,
	}: { children: React.ReactNode; params: { workspaceId: string }; to: string }) => {
		const href = to.replace('$workspaceId', params.workspaceId)
		return <a href={href}>{children}</a>
	},
}))

import { api } from '@/lib/api'

const baseUsage = {
	plan: 'starter' as const,
	status: 'active' as const,
	tokens_used: 0,
	hard_cap_tokens: 32_000_000,
	period_start: Date.now() - 7 * 24 * 60 * 60 * 1000,
	period_resets_in_ms: 23 * 24 * 60 * 60 * 1000,
	stripe_customer_id: 'cus_x',
	stripe_subscription_id: 'sub_x',
}

function renderBanner() {
	return render(
		<TestWrapper>
			<UsageStateBanner workspaceId="ws-1" />
		</TestWrapper>,
	)
}

describe('UsageStateBanner — near-cap state', () => {
	beforeEach(() => {
		vi.mocked(api.billing.usage).mockReset()
	})

	it('renders nothing while the usage query is loading', () => {
		vi.mocked(api.billing.usage).mockReturnValue(new Promise(() => {}))
		const { container } = renderBanner()
		expect(container).toBeEmptyDOMElement()
	})

	it('renders nothing for a fresh paid plan with plenty of headroom', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: 5_000_000, // ~15.6% used → 84% headroom
		})
		const { container } = renderBanner()
		await vi.waitFor(() => {
			expect(vi.mocked(api.billing.usage)).toHaveBeenCalled()
		})
		expect(container).toBeEmptyDOMElement()
	})

	it('hides at exactly 15% headroom (85% used boundary)', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: 27_200_000, // 85% used → headroom == 0.15 exactly
		})
		const { container } = renderBanner()
		await vi.waitFor(() => {
			expect(vi.mocked(api.billing.usage)).toHaveBeenCalled()
		})
		expect(container).toBeEmptyDOMElement()
	})

	it('shows one token past the 85% boundary', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: 27_200_001, // headroom just below 0.15
		})
		renderBanner()
		await screen.findByText(/of your Starter credits/)
	})

	it('shows when paid plan crosses the 85% threshold', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: 28_000_000, // 87.5% used
		})
		renderBanner()
		await screen.findByText(/87% of your Starter credits/)
		expect(screen.getByText(/resets in 23d/)).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Upgrade' })).toHaveAttribute(
			'href',
			'/ws-1/settings/keys',
		)
		expect(screen.getByRole('link', { name: 'Switch to BYO key' })).toHaveAttribute(
			'href',
			'/ws-1/settings/keys',
		)
		expect(screen.queryByRole('button', { name: /close|dismiss/i })).not.toBeInTheDocument()
	})

	it('fires on trial plans too', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'trial',
			hard_cap_tokens: 100_000,
			tokens_used: 90_000,
		})
		renderBanner()
		await screen.findByText(/90% of your trial credits/)
	})

	it('hides on BYO plans (no cap to track)', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'byollm',
			hard_cap_tokens: null,
			period_resets_in_ms: null,
		})
		const { container } = renderBanner()
		await vi.waitFor(() => {
			expect(vi.mocked(api.billing.usage)).toHaveBeenCalled()
		})
		expect(container).toBeEmptyDOMElement()
	})

	it('hides when hard_cap_tokens is null (no cap configured)', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			hard_cap_tokens: null,
		})
		const { container } = renderBanner()
		await vi.waitFor(() => {
			expect(vi.mocked(api.billing.usage)).toHaveBeenCalled()
		})
		expect(container).toBeEmptyDOMElement()
	})

	it('hides when tokens_used is NaN (defensive against webhook race)', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: Number.NaN,
		})
		const { container } = renderBanner()
		await vi.waitFor(() => {
			expect(vi.mocked(api.billing.usage)).toHaveBeenCalled()
		})
		expect(container).toBeEmptyDOMElement()
	})

	it('omits the reset hint when period_resets_in_ms is null', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: 29_000_000,
			period_resets_in_ms: null,
		})
		renderBanner()
		await screen.findByText(/credits/)
		expect(screen.queryByText(/resets in/)).not.toBeInTheDocument()
	})
})

describe('UsageStateBanner — over-cap state', () => {
	beforeEach(() => {
		vi.mocked(api.billing.usage).mockReset()
	})

	it('shows the over-cap banner exactly at the cap (used == cap)', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: baseUsage.hard_cap_tokens,
		})
		renderBanner()
		await screen.findByText(/over your Starter cap/)
		expect(screen.getByText(/resets in 23d/)).toBeInTheDocument()
	})

	it('shows when usage exceeds cap on Starter and routes upgrade to settings', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: baseUsage.hard_cap_tokens + 1_000_000,
		})
		renderBanner()
		await screen.findByText(/over your Starter cap/)
		// Starter sees the in-app upgrade CTA pointing at the settings row.
		const upgrade = screen.getByRole('link', { name: 'Upgrade' })
		expect(upgrade).toHaveAttribute('href', '/ws-1/settings/keys')
		const switchToByo = screen.getByRole('link', { name: 'Switch to BYO key' })
		expect(switchToByo).toHaveAttribute('href', '/ws-1/settings/keys')
		// Pro overage is out of v1 — Starter must not surface the Contact us mailto.
		expect(screen.queryByRole('link', { name: 'Contact us' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /close|dismiss/i })).not.toBeInTheDocument()
	})

	it('routes Pro over-cap to a Contact us mailto instead of settings', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'pro',
			tokens_used: baseUsage.hard_cap_tokens + 1,
		})
		renderBanner()
		await screen.findByText(/over your Pro cap/)
		const contact = screen.getByRole('link', { name: 'Contact us' })
		expect(contact.getAttribute('href') ?? '').toMatch(/^mailto:/)
		// The "Upgrade" affordance should not be present on Pro — the Pro→? path
		// is out of v1.
		expect(screen.queryByRole('link', { name: 'Upgrade' })).not.toBeInTheDocument()
	})

	it('shows for trial workspaces too', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'trial',
			hard_cap_tokens: 100_000,
			tokens_used: 100_000,
		})
		renderBanner()
		await screen.findByText(/over your trial cap/)
	})

	it('hides for BYO workspaces even if numbers look over-cap', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'byollm',
			hard_cap_tokens: null,
			tokens_used: 0,
		})
		const { container } = renderBanner()
		await vi.waitFor(() => {
			expect(vi.mocked(api.billing.usage)).toHaveBeenCalled()
		})
		expect(container).toBeEmptyDOMElement()
	})

	it('omits the reset hint on over-cap if period_resets_in_ms is null', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: baseUsage.hard_cap_tokens + 1,
			period_resets_in_ms: null,
		})
		renderBanner()
		await screen.findByText(/over your Starter cap/)
		expect(screen.queryByText(/resets in/)).not.toBeInTheDocument()
	})
})
