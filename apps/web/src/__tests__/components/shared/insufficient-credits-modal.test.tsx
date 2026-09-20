import {
	InsufficientCreditsModal,
	resolveTopupTarget,
} from '@/components/shared/insufficient-credits-modal'
import { _resetInsufficientCredits, openInsufficientCreditsModal } from '@/lib/insufficient-credits'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const navigateMock = vi.fn()
const trackCreditsExhaustedErrorShown = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return { ...mockTanStackRouter(), useNavigate: () => navigateMock }
})

vi.mock('@/lib/analytics', () => ({
	trackCreditsExhaustedErrorShown: (...args: unknown[]) => trackCreditsExhaustedErrorShown(...args),
}))

const PAYLOAD = {
	balance_cents: 42,
	min_reserve_cents: 50,
	topup_url: '/billing/credits',
}

function renderModal() {
	return render(<InsufficientCreditsModal />, {
		wrapper: createWorkspaceWrapper({ id: 'ws-1' }),
	})
}

describe('resolveTopupTarget', () => {
	it('follows an absolute https target as an external url', () => {
		expect(resolveTopupTarget('https://billing.example.com/credits')).toEqual({
			kind: 'external',
			url: 'https://billing.example.com/credits',
		})
	})

	it('resolves the relative backend value to billing settings', () => {
		expect(resolveTopupTarget('/billing/credits')).toEqual({ kind: 'billing-settings' })
	})

	it('resolves a non-https absolute value to billing settings rather than following it', () => {
		// A provider-supplied url is an external input; following a javascript:
		// or http: value would be an open redirect.
		expect(resolveTopupTarget('javascript:alert(1)')).toEqual({ kind: 'billing-settings' })
		expect(resolveTopupTarget('http://billing.example.com')).toEqual({
			kind: 'billing-settings',
		})
	})
})

describe('InsufficientCreditsModal', () => {
	beforeEach(() => {
		navigateMock.mockReset()
		trackCreditsExhaustedErrorShown.mockReset()
		_resetInsufficientCredits()
		localStorage.setItem('ff:maskin-credit-ux', 'on')
	})

	it('renders the exact copy and both CTAs for the open payload', async () => {
		renderModal()
		act(() => {
			openInsufficientCreditsModal(PAYLOAD)
		})

		const dialog = await screen.findByRole('dialog')
		expect(screen.getByText('Out of credits')).toBeInTheDocument()
		expect(
			screen.getByText('Your workspace balance is $0.42. Top up to run this agent.'),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Top up credits' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
		expect(dialog).toBeInTheDocument()
	})

	it('fires credits_exhausted_error_shown once with workspace_id and balance_cents', async () => {
		renderModal()
		act(() => {
			openInsufficientCreditsModal(PAYLOAD)
		})

		await screen.findByRole('dialog')
		await waitFor(() =>
			expect(trackCreditsExhaustedErrorShown).toHaveBeenCalledWith({
				workspace_id: 'ws-1',
				balance_cents: 42,
			}),
		)
		expect(trackCreditsExhaustedErrorShown).toHaveBeenCalledTimes(1)
	})

	it('dismisses on Close without navigating', async () => {
		renderModal()
		act(() => {
			openInsufficientCreditsModal(PAYLOAD)
		})
		await screen.findByRole('dialog')

		await userEvent.click(screen.getByRole('button', { name: 'Close' }))
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
		expect(navigateMock).not.toHaveBeenCalled()
	})

	it('navigates to billing settings when the payload carries a relative url', async () => {
		renderModal()
		act(() => {
			openInsufficientCreditsModal(PAYLOAD)
		})
		await screen.findByRole('dialog')

		await userEvent.click(screen.getByRole('button', { name: 'Top up credits' }))
		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/settings/billing',
			params: { workspaceId: 'ws-1' },
		})
	})

	it('does not open while the MASKIN_CREDIT_UX flag is off', () => {
		localStorage.setItem('ff:maskin-credit-ux', 'off')
		renderModal()

		let opened: boolean | undefined
		act(() => {
			opened = openInsufficientCreditsModal(PAYLOAD)
		})
		expect(opened).toBe(false)
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
	})
})
