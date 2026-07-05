import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			...actual.api,
			auth: { ...actual.api.auth, changePassword: vi.fn() },
		},
	}
})

vi.mock('@/lib/auth', () => ({
	setApiKey: vi.fn(),
}))

vi.mock('@/lib/analytics', () => ({
	trackEvent: vi.fn(),
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { PasswordRow } from '@/components/profile/password-row'
import { trackEvent } from '@/lib/analytics'
import { ApiError, api } from '@/lib/api'
import { setApiKey } from '@/lib/auth'
import { toast } from 'sonner'
import { buildActorWithKey } from '../../factories'
import { TestWrapper } from '../../setup'

function renderRow() {
	return render(<PasswordRow />, { wrapper: TestWrapper })
}

beforeEach(() => {
	vi.clearAllMocks()
})

async function openDialog() {
	fireEvent.click(screen.getByRole('button', { name: /change password/i }))
	await screen.findByRole('dialog')
}

function fillForm(values: { current?: string; next?: string; confirm?: string } = {}) {
	const { current = 'oldpass', next = 'newpass12', confirm = 'newpass12' } = values
	fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: current } })
	fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: next } })
	fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: confirm } })
}

describe('PasswordRow', () => {
	it('renders the row with a change button and no dialog initially', () => {
		renderRow()
		expect(screen.getByText('Password')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /change password/i })).toBeInTheDocument()
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
	})

	it('keeps submit disabled until the form is valid', async () => {
		renderRow()
		await openDialog()
		const submit = screen.getByRole('button', { name: /update password/i })
		expect(submit).toBeDisabled()
		fillForm({ next: 'short', confirm: 'short' })
		expect(submit).toBeDisabled()
		fillForm({ confirm: 'mismatch1' })
		expect(submit).toBeDisabled()
		fillForm()
		expect(submit).not.toBeDisabled()
	})

	it('shows inline error when new password is too short', async () => {
		renderRow()
		await openDialog()
		fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: 'short' } })
		fireEvent.blur(screen.getByLabelText(/^new password/i))
		expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument()
	})

	it('shows inline error when confirmation does not match', async () => {
		renderRow()
		await openDialog()
		fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: 'newpass12' } })
		fireEvent.change(screen.getByLabelText(/confirm new password/i), {
			target: { value: 'different' },
		})
		fireEvent.blur(screen.getByLabelText(/confirm new password/i))
		expect(screen.getByText(/passwords don't match/i)).toBeInTheDocument()
	})

	it('calls the endpoint, rotates the key, toasts, and closes on success', async () => {
		const rotated = buildActorWithKey({ id: 'actor-1', api_key: 'ank_new_key' })
		vi.mocked(api.auth.changePassword).mockResolvedValue(rotated)

		renderRow()
		await openDialog()
		fillForm()
		fireEvent.click(screen.getByRole('button', { name: /update password/i }))

		await waitFor(() =>
			expect(api.auth.changePassword).toHaveBeenCalledWith({
				current_password: 'oldpass',
				new_password: 'newpass12',
			}),
		)
		await waitFor(() => expect(setApiKey).toHaveBeenCalledWith('ank_new_key'))
		expect(trackEvent).toHaveBeenCalledWith('profile.field_changed', { field: 'password' })
		expect(toast.success).toHaveBeenCalledWith('Password updated')
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
	})

	it('shows a current-password error when the endpoint returns 401', async () => {
		vi.mocked(api.auth.changePassword).mockRejectedValue(
			new ApiError(401, 'Current password is incorrect'),
		)

		renderRow()
		await openDialog()
		fillForm({ current: 'wrong' })
		fireEvent.click(screen.getByRole('button', { name: /update password/i }))

		expect(await screen.findByText(/current password is incorrect/i)).toBeInTheDocument()
		expect(setApiKey).not.toHaveBeenCalled()
		expect(screen.getByRole('dialog')).toBeInTheDocument()
	})
})
