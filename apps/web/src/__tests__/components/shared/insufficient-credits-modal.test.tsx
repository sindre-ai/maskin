import {
	InsufficientCreditsModal,
	resolveTopupTarget,
} from '@/components/shared/insufficient-credits-modal'
import { _resetInsufficientCredits, openInsufficientCreditsModal } from '@/lib/insufficient-credits'
import { WorkspaceContext } from '@/lib/workspace-context'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspaceWithRole } from '../../factories'
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

/** Same modal, but the workspace id is a prop so a test can switch it. */
function WorkspaceHarness({ workspaceId }: { workspaceId: string }) {
	const workspace = buildWorkspaceWithRole({ id: workspaceId })
	return (
		<WorkspaceContext.Provider value={{ workspace, workspaceId, sseStatus: 'connected' }}>
			<InsufficientCreditsModal />
		</WorkspaceContext.Provider>
	)
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

	it('passes any other value through verbatim, not collapsed onto billing settings', () => {
		// The frontend follows whatever the backend sends once the real path
		// lands (Task 3), rather than guessing it is billing settings.
		expect(resolveTopupTarget('/settings/plans')).toEqual({
			kind: 'external',
			url: '/settings/plans',
		})
		expect(resolveTopupTarget('https://billing.example.com/credits')).toEqual({
			kind: 'external',
			url: 'https://billing.example.com/credits',
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

	it('clears on workspace switch and does not re-fire with the old balance', async () => {
		const { rerender } = render(<WorkspaceHarness workspaceId="ws-1" />)
		act(() => {
			openInsufficientCreditsModal(PAYLOAD)
		})
		await screen.findByRole('dialog')
		await waitFor(() => expect(trackCreditsExhaustedErrorShown).toHaveBeenCalledTimes(1))

		rerender(<WorkspaceHarness workspaceId="ws-2" />)

		// The stale 402 belongs to ws-1: the modal closes and the event does not
		// re-fire against the new workspace id with the old balance.
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
		expect(trackCreditsExhaustedErrorShown).toHaveBeenCalledTimes(1)
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
