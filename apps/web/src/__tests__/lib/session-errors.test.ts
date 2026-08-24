vi.mock('sonner', () => ({
	toast: { error: vi.fn() },
}))

// Must import after mock setup
import { ApiError } from '@/lib/api'
import { toastSessionCreateError } from '@/lib/session-errors'
import { toast } from 'sonner'

describe('toastSessionCreateError', () => {
	const navigate = vi.fn()
	const workspaceId = 'ws-1'

	beforeEach(() => {
		vi.mocked(toast.error).mockClear()
		navigate.mockClear()
	})

	it('shows a trial-specific message with a Go to Billing action for a trial workspace', () => {
		const err = new ApiError(402, 'Trial cap exceeded')
		err.code = 'PLAN_CAP_EXCEEDED'
		err.planCapContext = { plan: 'trial', used: 8_000_000, cap: 8_000_000, period_end: null }

		// biome-ignore lint/suspicious/noExplicitAny: navigate's real type is the router's overloaded signature, irrelevant to this test
		toastSessionCreateError(err, navigate as any, workspaceId)

		expect(toast.error).toHaveBeenCalledWith(
			'Trial limit reached — upgrade to keep going',
			expect.objectContaining({ action: expect.objectContaining({ label: 'Go to Billing' }) }),
		)

		const call = vi.mocked(toast.error).mock.calls[0]
		const options = call?.[1] as unknown as { action: { onClick: () => void } }
		options.action.onClick()
		expect(navigate).toHaveBeenCalledWith({
			to: '/$workspaceId/settings/keys',
			params: { workspaceId },
		})
	})

	it('shows a credits/upgrade message for a paid plan over cap', () => {
		const err = new ApiError(402, 'Plan cap exceeded')
		err.code = 'PLAN_CAP_EXCEEDED'
		err.planCapContext = { plan: 'pro', used: 32_000_000, cap: 32_000_000, period_end: null }

		// biome-ignore lint/suspicious/noExplicitAny: navigate's real type is the router's overloaded signature, irrelevant to this test
		toastSessionCreateError(err, navigate as any, workspaceId)

		expect(toast.error).toHaveBeenCalledWith(
			'Plan limit reached — buy usage credits or upgrade to keep going',
			expect.objectContaining({ action: expect.objectContaining({ label: 'Go to Billing' }) }),
		)
	})

	it('falls back to a generic error toast for a non-plan-cap error', () => {
		// biome-ignore lint/suspicious/noExplicitAny: navigate's real type is the router's overloaded signature, irrelevant to this test
		toastSessionCreateError(new Error('network down'), navigate as any, workspaceId)

		expect(toast.error).toHaveBeenCalledWith('network down')
		expect(navigate).not.toHaveBeenCalled()
	})

	it('falls back to a generic message for a non-Error throw', () => {
		// biome-ignore lint/suspicious/noExplicitAny: navigate's real type is the router's overloaded signature, irrelevant to this test
		toastSessionCreateError('boom', navigate as any, workspaceId)

		expect(toast.error).toHaveBeenCalledWith('Failed to start session')
	})

	it('prefers a caller-supplied fallback message for a non-plan-cap error', () => {
		toastSessionCreateError(
			new Error('network down'),
			// biome-ignore lint/suspicious/noExplicitAny: navigate's real type is the router's overloaded signature, irrelevant to this test
			navigate as any,
			workspaceId,
			"Couldn't start Researcher",
		)

		expect(toast.error).toHaveBeenCalledWith("Couldn't start Researcher")
	})

	it('ignores the fallback message for a plan-cap error so the upgrade CTA still shows', () => {
		const err = new ApiError(402, 'Trial cap exceeded')
		err.code = 'PLAN_CAP_EXCEEDED'
		err.planCapContext = { plan: 'trial', used: 600, cap: 500, period_end: null }

		toastSessionCreateError(
			err,
			// biome-ignore lint/suspicious/noExplicitAny: navigate's real type is the router's overloaded signature, irrelevant to this test
			navigate as any,
			workspaceId,
			"Couldn't start Researcher",
		)

		expect(toast.error).toHaveBeenCalledWith(
			'Trial limit reached — upgrade to keep going',
			expect.objectContaining({ action: expect.objectContaining({ label: 'Go to Billing' }) }),
		)
	})
})
