import { NearCapBanner } from '@/components/billing/near-cap-banner'
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
			<NearCapBanner workspaceId="ws-1" />
		</TestWrapper>,
	)
}

describe('NearCapBanner', () => {
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

	it('hides once usage hits or exceeds the cap (over-cap is a separate task)', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: baseUsage.hard_cap_tokens,
		})
		const { container } = renderBanner()
		await vi.waitFor(() => {
			expect(vi.mocked(api.billing.usage)).toHaveBeenCalled()
		})
		expect(container).toBeEmptyDOMElement()
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
