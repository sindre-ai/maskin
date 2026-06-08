import {
	OverCapComposerNotice,
	useOverCapBlock,
} from '@/components/billing/over-cap-composer-notice'
import { render, renderHook, screen } from '@testing-library/react'
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
		className,
	}: {
		children: React.ReactNode
		params: { workspaceId: string }
		to: string
		className?: string
	}) => {
		const href = to.replace('$workspaceId', params.workspaceId)
		return (
			<a href={href} className={className}>
				{children}
			</a>
		)
	},
}))

import { api } from '@/lib/api'

const baseUsage = {
	plan: 'starter' as const,
	status: 'active' as const,
	tokens_used: 0,
	hard_cap_tokens: 32_000_000,
	period_start: Date.now() - 7 * 24 * 60 * 60 * 1000,
	period_resets_in_ms: 5 * 24 * 60 * 60 * 1000,
	stripe_customer_id: 'cus_x',
	stripe_subscription_id: 'sub_x',
}

function renderNotice() {
	return render(
		<TestWrapper>
			<OverCapComposerNotice workspaceId="ws-1" />
		</TestWrapper>,
	)
}

describe('OverCapComposerNotice', () => {
	beforeEach(() => {
		vi.mocked(api.billing.usage).mockReset()
	})

	it('renders nothing while usage is loading', () => {
		vi.mocked(api.billing.usage).mockReturnValue(new Promise(() => {}))
		const { container } = renderNotice()
		expect(container).toBeEmptyDOMElement()
	})

	it('renders nothing in the normal state', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: 1_000_000,
		})
		const { container } = renderNotice()
		await vi.waitFor(() => {
			expect(vi.mocked(api.billing.usage)).toHaveBeenCalled()
		})
		expect(container).toBeEmptyDOMElement()
	})

	it('renders nothing in the near-cap state (only the banner nudges then)', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: 29_000_000,
		})
		const { container } = renderNotice()
		await vi.waitFor(() => {
			expect(vi.mocked(api.billing.usage)).toHaveBeenCalled()
		})
		expect(container).toBeEmptyDOMElement()
	})

	it('renders the agents-paused notice when over-cap', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: baseUsage.hard_cap_tokens + 1,
		})
		renderNotice()
		await screen.findByText(/Agents paused/)
		expect(screen.getByText(/out of credits, resets in 5d/)).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Upgrade' })).toHaveAttribute(
			'href',
			'/ws-1/settings/keys',
		)
		expect(screen.getByRole('link', { name: 'switch to BYO key' })).toHaveAttribute(
			'href',
			'/ws-1/settings/keys',
		)
	})

	it('hides for BYO workspaces', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'byollm',
			hard_cap_tokens: null,
			tokens_used: 0,
		})
		const { container } = renderNotice()
		await vi.waitFor(() => {
			expect(vi.mocked(api.billing.usage)).toHaveBeenCalled()
		})
		expect(container).toBeEmptyDOMElement()
	})
})

describe('useOverCapBlock', () => {
	beforeEach(() => {
		vi.mocked(api.billing.usage).mockReset()
	})

	it('returns false while loading (let the call go through; backend will 402 if needed)', () => {
		vi.mocked(api.billing.usage).mockReturnValue(new Promise(() => {}))
		const { result } = renderHook(() => useOverCapBlock('ws-1'), { wrapper: TestWrapper })
		expect(result.current).toBe(false)
	})

	it('returns false in the normal state', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({ ...baseUsage, tokens_used: 1_000_000 })
		const { result } = renderHook(() => useOverCapBlock('ws-1'), { wrapper: TestWrapper })
		await vi.waitFor(() => {
			expect(vi.mocked(api.billing.usage)).toHaveBeenCalled()
		})
		expect(result.current).toBe(false)
	})

	it('returns false in the near-cap state — banner nudges, sends still allowed', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: 29_000_000,
		})
		const { result } = renderHook(() => useOverCapBlock('ws-1'), { wrapper: TestWrapper })
		await vi.waitFor(() => {
			expect(vi.mocked(api.billing.usage)).toHaveBeenCalled()
		})
		expect(result.current).toBe(false)
	})

	it('returns true once usage hits the cap', async () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			tokens_used: baseUsage.hard_cap_tokens,
		})
		const { result } = renderHook(() => useOverCapBlock('ws-1'), { wrapper: TestWrapper })
		await vi.waitFor(() => {
			expect(result.current).toBe(true)
		})
	})

	it('returns false for BYO workspaces', () => {
		vi.mocked(api.billing.usage).mockResolvedValue({
			...baseUsage,
			plan: 'byollm',
			hard_cap_tokens: null,
			tokens_used: 0,
		})
		const { result } = renderHook(() => useOverCapBlock('ws-1'), { wrapper: TestWrapper })
		expect(result.current).toBe(false)
	})
})
