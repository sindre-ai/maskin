import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			...actual.api,
			auth: {
				...actual.api.auth,
				requestEmailChange: vi.fn(),
				cancelEmailChange: vi.fn(),
			},
		},
	}
})

vi.mock('@/lib/analytics', () => ({
	trackEvent: vi.fn(),
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { EmailRow } from '@/components/profile/email-row'
import { trackEvent } from '@/lib/analytics'
import { type ActorResponse, type ActorWithKey, ApiError, api } from '@/lib/api'
import { toast } from 'sonner'
import { buildActorResponse, buildActorWithKey } from '../../factories'
import { TestWrapper } from '../../setup'

function renderRow(overrides: Partial<ActorResponse> = {}) {
	const actor = buildActorResponse({
		id: 'actor-1',
		email: 'alice@example.com',
		pending_email: null,
		...overrides,
	})
	return { actor, ...render(<EmailRow actor={actor} />, { wrapper: TestWrapper }) }
}

async function openDialog() {
	fireEvent.click(screen.getByRole('button', { name: /change email/i }))
	await screen.findByRole('dialog')
}

function fillForm({
	email = 'new@example.com',
	password = 'pw',
}: { email?: string; password?: string } = {}) {
	fireEvent.change(screen.getByLabelText(/new email/i), { target: { value: email } })
	fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: password } })
}

function bannerText(): string {
	const banner = screen
		.getByText(/verify your new email address/i)
		.closest('[data-row="email-verification"]')
	return banner?.textContent ?? ''
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('EmailRow', () => {
	it('renders the actor email and a Change button (no dialog, no banner)', () => {
		renderRow()
		expect(screen.getByText('alice@example.com')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /change email/i })).toBeInTheDocument()
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
		expect(screen.queryByText(/verify your new email/i)).not.toBeInTheDocument()
	})

	it('renders an em-dash when the actor has no email set', () => {
		renderRow({ email: null })
		expect(screen.getByText('—')).toBeInTheDocument()
	})

	it('keeps submit disabled until the form is valid', async () => {
		renderRow()
		await openDialog()
		const submit = screen.getByRole('button', { name: /send verification email/i })
		expect(submit).toBeDisabled()
		fillForm({ email: 'not-an-email' })
		expect(submit).toBeDisabled()
		fillForm({ email: 'alice@example.com' }) // same as current
		expect(submit).toBeDisabled()
		fillForm({ email: 'ALICE@example.com' }) // same as current, different case
		expect(submit).toBeDisabled()
		fillForm({ email: 'new@example.com', password: '' })
		expect(submit).toBeDisabled()
		fillForm({ email: 'new@example.com', password: 'pw' })
		expect(submit).not.toBeDisabled()
	})

	it('calls requestEmailChange with an Idempotency-Key, fires telemetry, toasts, and closes the dialog on success', async () => {
		vi.mocked(api.auth.requestEmailChange).mockResolvedValue(
			buildActorWithKey({ id: 'actor-1', pending_email: 'new@example.com' }),
		)
		renderRow()
		await openDialog()
		fillForm()
		fireEvent.click(screen.getByRole('button', { name: /send verification email/i }))

		await waitFor(() => expect(api.auth.requestEmailChange).toHaveBeenCalledTimes(1))
		const [body, idempotencyKey] = vi.mocked(api.auth.requestEmailChange).mock.calls[0]
		expect(body).toEqual({ new_email: 'new@example.com', current_password: 'pw' })
		expect(idempotencyKey).toEqual(expect.any(String))
		expect(idempotencyKey).not.toEqual('')
		expect(trackEvent).toHaveBeenCalledWith('profile.field_changed', {
			field: 'pending_email',
		})
		expect(toast.success).toHaveBeenCalledWith('Verification email sent to new@example.com')
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
	})

	it('generates a distinct Idempotency-Key on each submit click', async () => {
		vi.mocked(api.auth.requestEmailChange).mockResolvedValue(
			buildActorWithKey({ id: 'actor-1', pending_email: 'new@example.com' }),
		)
		renderRow()

		await openDialog()
		fillForm()
		fireEvent.click(screen.getByRole('button', { name: /send verification email/i }))
		await waitFor(() => expect(api.auth.requestEmailChange).toHaveBeenCalledTimes(1))

		await openDialog()
		fillForm()
		fireEvent.click(screen.getByRole('button', { name: /send verification email/i }))
		await waitFor(() => expect(api.auth.requestEmailChange).toHaveBeenCalledTimes(2))

		const key1 = vi.mocked(api.auth.requestEmailChange).mock.calls[0][1]
		const key2 = vi.mocked(api.auth.requestEmailChange).mock.calls[1][1]
		expect(key1).not.toEqual(key2)
	})

	it('clears the password and email fields after a successful submit, even if reopened', async () => {
		vi.mocked(api.auth.requestEmailChange).mockResolvedValue(
			buildActorWithKey({ id: 'actor-1', pending_email: 'new@example.com' }),
		)
		renderRow()
		await openDialog()
		fillForm({ email: 'new@example.com', password: 'super-secret' })
		fireEvent.click(screen.getByRole('button', { name: /send verification email/i }))

		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

		await openDialog()
		expect(screen.getByLabelText(/new email/i)).toHaveValue('')
		expect(screen.getByLabelText(/current password/i)).toHaveValue('')
	})

	it('shows an inline password error only when the 401 carries a current_password field detail', async () => {
		vi.mocked(api.auth.requestEmailChange).mockRejectedValue(
			new ApiError(401, 'Current password is incorrect', {
				current_password: ['Current password is incorrect'],
			}),
		)
		renderRow()
		await openDialog()
		fillForm({ password: 'wrong' })
		fireEvent.click(screen.getByRole('button', { name: /send verification email/i }))

		expect(await screen.findByText(/current password is incorrect/i)).toBeInTheDocument()
		expect(screen.getByRole('dialog')).toBeInTheDocument()
	})

	it('falls through to generic copy on a bare 401 (e.g. session expired) without prompting for the password again', async () => {
		vi.mocked(api.auth.requestEmailChange).mockRejectedValue(new ApiError(401, 'Unauthorized'))
		renderRow()
		await openDialog()
		fillForm({ password: 'pw' })
		fireEvent.click(screen.getByRole('button', { name: /send verification email/i }))

		expect(await screen.findByText(/could not request email change/i)).toBeInTheDocument()
		// The wrong-password inline error must NOT appear — that would push the
		// user into re-entering credentials into an invalidated session.
		expect(screen.queryByText(/current password is incorrect/i)).not.toBeInTheDocument()
		expect(screen.getByRole('dialog')).toBeInTheDocument()
	})

	it('falls through to generic copy when the 401 current_password error array is empty', async () => {
		vi.mocked(api.auth.requestEmailChange).mockRejectedValue(
			new ApiError(401, 'Unauthorized', { current_password: [] }),
		)
		renderRow()
		await openDialog()
		fillForm({ password: 'pw' })
		fireEvent.click(screen.getByRole('button', { name: /send verification email/i }))

		expect(await screen.findByText(/could not request email change/i)).toBeInTheDocument()
		expect(screen.queryByText(/current password is incorrect/i)).not.toBeInTheDocument()
	})

	it('does not leak raw error messages on non-401/409 failures', async () => {
		vi.mocked(api.auth.requestEmailChange).mockRejectedValue(
			new ApiError(500, 'pendingEmail: Expected string, received number'),
		)
		renderRow()
		await openDialog()
		fillForm()
		fireEvent.click(screen.getByRole('button', { name: /send verification email/i }))

		expect(await screen.findByText(/could not request email change/i)).toBeInTheDocument()
		// Generic copy only — the backend/Zod detail string must not be rendered.
		expect(screen.queryByText(/pendingEmail/i)).not.toBeInTheDocument()
	})

	it('shows an inline email error when the endpoint returns 409 (address already in use)', async () => {
		vi.mocked(api.auth.requestEmailChange).mockRejectedValue(
			new ApiError(409, 'Email already in use'),
		)
		renderRow()
		await openDialog()
		fillForm({ email: 'taken@example.com' })
		fireEvent.click(screen.getByRole('button', { name: /send verification email/i }))

		expect(await screen.findByText(/already in use/i)).toBeInTheDocument()
		expect(screen.getByRole('dialog')).toBeInTheDocument()
	})

	it('renders the persistent verification banner when pending_email is set', () => {
		renderRow({ pending_email: 'new@example.com' })
		expect(screen.getByText(/verify your new email/i)).toBeInTheDocument()
		expect(screen.getByText('new@example.com')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /resend verification email/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /cancel email change/i })).toBeInTheDocument()
		const banner = screen
			.getByText(/verify your new email address/i)
			.closest('[data-row="email-verification"]')
		expect(banner).toHaveAttribute('aria-live', 'polite')
		// No "Re-sent" affordance until the user actually triggers a resend.
		expect(bannerText()).not.toMatch(/re-sent/i)
	})

	it('cancels a pending change via the banner with an Idempotency-Key and toasts on success', async () => {
		vi.mocked(api.auth.cancelEmailChange).mockResolvedValue(
			buildActorWithKey({ id: 'actor-1', pending_email: null }),
		)
		renderRow({ pending_email: 'new@example.com' })

		fireEvent.click(screen.getByRole('button', { name: /cancel email change/i }))

		await waitFor(() => expect(api.auth.cancelEmailChange).toHaveBeenCalledTimes(1))
		const [idempotencyKey] = vi.mocked(api.auth.cancelEmailChange).mock.calls[0]
		expect(idempotencyKey).toEqual(expect.any(String))
		expect(idempotencyKey).not.toEqual('')
		expect(toast.success).toHaveBeenCalledWith('Email change cancelled')
	})

	it('generates a distinct Idempotency-Key on each cancel click', async () => {
		// Return pending_email still set so the banner (and Cancel button) stays visible after the first cancel.
		vi.mocked(api.auth.cancelEmailChange).mockResolvedValue(
			buildActorWithKey({ id: 'actor-1', pending_email: 'new@example.com' }),
		)
		renderRow({ pending_email: 'new@example.com' })

		fireEvent.click(screen.getByRole('button', { name: /cancel email change/i }))
		await waitFor(() => expect(api.auth.cancelEmailChange).toHaveBeenCalledTimes(1))

		fireEvent.click(screen.getByRole('button', { name: /cancel email change/i }))
		await waitFor(() => expect(api.auth.cancelEmailChange).toHaveBeenCalledTimes(2))

		const key1 = vi.mocked(api.auth.cancelEmailChange).mock.calls[0][0]
		const key2 = vi.mocked(api.auth.cancelEmailChange).mock.calls[1][0]
		expect(key1).not.toEqual(key2)
	})

	it('shows a session-expired toast when the cancel endpoint returns 401', async () => {
		vi.mocked(api.auth.cancelEmailChange).mockRejectedValue(new ApiError(401, 'Unauthorized'))
		renderRow({ pending_email: 'new@example.com' })

		fireEvent.click(screen.getByRole('button', { name: /cancel email change/i }))

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				'Your session has expired. Please sign in again.',
			),
		)
		// Banner stays — the cancel didn't succeed, so the user can see the state.
		expect(screen.getByText(/verify your new email/i)).toBeInTheDocument()
	})

	it('shows a generic error toast when cancelling the pending change fails (does not leak raw err.message)', async () => {
		vi.mocked(api.auth.cancelEmailChange).mockRejectedValue(
			new Error('pendingEmail: Expected string, received number'),
		)
		renderRow({ pending_email: 'new@example.com' })

		fireEvent.click(screen.getByRole('button', { name: /cancel email change/i }))

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith('Could not cancel email change. Please try again.'),
		)
		// Banner stays — the cancel didn't succeed, so the user can retry.
		expect(screen.getByText(/verify your new email/i)).toBeInTheDocument()
	})

	it('Resend reopens the dialog with the pending email pre-filled', async () => {
		renderRow({ pending_email: 'new@example.com' })

		fireEvent.click(screen.getByRole('button', { name: /resend verification email/i }))
		await screen.findByRole('dialog')

		await waitFor(() => expect(screen.getByLabelText(/new email/i)).toHaveValue('new@example.com'))
		// Password is intentionally NOT pre-filled — we still require it on resend.
		expect(screen.getByLabelText(/current password/i)).toHaveValue('')
	})

	it('toasts re-sent copy and surfaces a "Re-sent" line in the banner after a resend', async () => {
		vi.mocked(api.auth.requestEmailChange).mockResolvedValue(
			buildActorWithKey({ id: 'actor-1', pending_email: 'new@example.com' }),
		)
		renderRow({ pending_email: 'new@example.com' })

		fireEvent.click(screen.getByRole('button', { name: /resend verification email/i }))
		await screen.findByRole('dialog')
		// Email is pre-filled — submit the same address to exercise the resend path.
		fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: 'pw' } })
		fireEvent.click(screen.getByRole('button', { name: /^send verification email$/i }))

		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Verification email re-sent to new@example.com'),
		)
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
		await waitFor(() => expect(bannerText()).toMatch(/re-sent/i))
	})

	it('warns inline when the resend dialog is edited to a different address', async () => {
		renderRow({ pending_email: 'new@example.com' })

		fireEvent.click(screen.getByRole('button', { name: /resend verification email/i }))
		await screen.findByRole('dialog')

		// Pre-filled with the pending address — no warning yet.
		expect(screen.queryByText(/replaces your current pending change/i)).not.toBeInTheDocument()

		fireEvent.change(screen.getByLabelText(/new email/i), {
			target: { value: 'other@example.com' },
		})

		expect(await screen.findByText(/replaces your current pending change/i)).toBeInTheDocument()
	})

	it('does not show the divergence warning in a fresh change dialog', async () => {
		renderRow()
		await openDialog()
		fillForm({ email: 'other@example.com', password: 'pw' })
		expect(screen.queryByText(/replaces your current pending change/i)).not.toBeInTheDocument()
	})

	it('disables Resend while a Cancel is in flight', async () => {
		let resolveCancel: (value: ActorWithKey) => void = () => {}
		vi.mocked(api.auth.cancelEmailChange).mockImplementation(
			() =>
				new Promise<ActorWithKey>((r) => {
					resolveCancel = r
				}),
		)
		renderRow({ pending_email: 'new@example.com' })

		const cancelBtn = screen.getByRole('button', { name: /cancel email change/i })
		const resendBtn = screen.getByRole('button', { name: /resend verification email/i })
		expect(cancelBtn).not.toBeDisabled()
		expect(resendBtn).not.toBeDisabled()

		fireEvent.click(cancelBtn)

		await waitFor(() => expect(cancelBtn).toBeDisabled())
		expect(resendBtn).toBeDisabled()

		resolveCancel(buildActorWithKey({ id: 'actor-1', pending_email: null }))
		await waitFor(() => expect(cancelBtn).not.toBeDisabled())
	})
})
