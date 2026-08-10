import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSendMagicLink = vi.fn()
const mockCompleteFromRedirect = vi.fn()

vi.mock('@/hooks/use-vaerksted-auth', () => ({
	useVaerkstedAuth: () => ({
		loading: false,
		sendMagicLink: mockSendMagicLink,
		completeFromRedirect: mockCompleteFromRedirect,
	}),
}))

vi.mock('@/lib/api', () => ({
	api: {
		landingEvents: { emit: vi.fn() },
	},
}))

vi.mock('@/lib/analytics', () => ({
	trackEvent: vi.fn(),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

import { trackEvent } from '@/lib/analytics'
import { api } from '@/lib/api'
import { Route } from '@/routes/signup'

const SignupPage = (Route as unknown as { component: React.FC }).component

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
	await user.type(screen.getByPlaceholderText('Company name'), 'Test Co')
	await user.type(screen.getByPlaceholderText('What you do'), 'Founder')
	await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
	await user.click(screen.getByRole('button', { name: 'Create account' }))
}

describe('SignupPage', () => {
	const originalLocation = window.location

	beforeEach(() => {
		vi.clearAllMocks()
		mockCompleteFromRedirect.mockResolvedValue(null)
		localStorage.clear()
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: {
				...originalLocation,
				href: 'http://localhost/signup',
				pathname: '/signup',
				search: '',
				hash: '',
				assign: vi.fn(),
			},
		})
	})

	afterEach(() => {
		localStorage.clear()
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: originalLocation,
		})
	})

	it('renders a vaerksted-only signup form: name/organization/role/email, no password fields', () => {
		render(<SignupPage />)
		expect(screen.getByRole('heading', { name: 'Create account' })).toBeInTheDocument()
		expect(screen.getByPlaceholderText('Your name')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('Company name')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('What you do')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument()
		expect(screen.queryByPlaceholderText('At least 8 characters')).not.toBeInTheDocument()
		expect(screen.queryByPlaceholderText('Repeat your password')).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument()
	})

	it('emits signup_form_started once when the form first renders', () => {
		render(<SignupPage />)
		expect(trackEvent).toHaveBeenCalledWith('signup_form_started', {})
		expect(
			vi.mocked(trackEvent).mock.calls.filter((c) => c[0] === 'signup_form_started'),
		).toHaveLength(1)
	})

	it('completes the magic-link redirect handshake on mount', () => {
		render(<SignupPage />)
		expect(mockCompleteFromRedirect).toHaveBeenCalledTimes(1)
	})

	it('renders link to login page', () => {
		render(<SignupPage />)
		expect(screen.getByText('Sign in')).toBeInTheDocument()
	})

	it('shows "Name is required" when submitting without name', async () => {
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByText('Name is required')).toBeInTheDocument()
		expect(mockSendMagicLink).not.toHaveBeenCalled()
	})

	it('shows "Organization is required" when submitting without organization', async () => {
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByText('Organization is required')).toBeInTheDocument()
		expect(mockSendMagicLink).not.toHaveBeenCalled()
	})

	it('shows "Role is required" when submitting without role', async () => {
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
		await user.type(screen.getByPlaceholderText('Company name'), 'Test Co')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByText('Role is required')).toBeInTheDocument()
		expect(mockSendMagicLink).not.toHaveBeenCalled()
	})

	it('shows "Email is required" when submitting without email', async () => {
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
		await user.type(screen.getByPlaceholderText('Company name'), 'Test Co')
		await user.type(screen.getByPlaceholderText('What you do'), 'Founder')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByText('Email is required')).toBeInTheDocument()
		expect(mockSendMagicLink).not.toHaveBeenCalled()
	})

	it('calls sendMagicLink with trimmed email and profile on valid submit', async () => {
		mockSendMagicLink.mockResolvedValue(undefined)
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), '  Test User  ')
		await user.type(screen.getByPlaceholderText('Company name'), '  Test Co  ')
		await user.type(screen.getByPlaceholderText('What you do'), '  Founder  ')
		await user.type(screen.getByPlaceholderText('you@example.com'), '  test@example.com  ')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		await waitFor(() => {
			expect(mockSendMagicLink).toHaveBeenCalledWith('test@example.com', {
				name: 'Test User',
				organization: 'Test Co',
				role: 'Founder',
			})
		})
	})

	it('shows "Check your email" after a successful send', async () => {
		mockSendMagicLink.mockResolvedValue(undefined)
		const user = userEvent.setup()
		render(<SignupPage />)
		await fillAndSubmit(user)
		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Check your email' })).toBeDisabled()
		})
	})

	it('displays error message when sendMagicLink throws', async () => {
		mockSendMagicLink.mockRejectedValue(new Error('vaerksted sign-in is not configured'))
		const user = userEvent.setup()
		render(<SignupPage />)
		await fillAndSubmit(user)
		await waitFor(() => {
			expect(screen.getByText('vaerksted sign-in is not configured')).toBeInTheDocument()
		})
	})

	it('clears error when user types in any field', async () => {
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByText('Name is required')).toBeInTheDocument()
		await user.type(screen.getByPlaceholderText('Your name'), 'a')
		expect(screen.queryByText('Name is required')).not.toBeInTheDocument()
	})

	it('imports pending_prompt/anon_id from the URL into localStorage on mount (unrelated to auth mechanism)', () => {
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: {
				...originalLocation,
				href: 'http://localhost/signup?pending_prompt=Help%20me&anon_id=anon-123',
				pathname: '/signup',
				search: '?pending_prompt=Help%20me&anon_id=anon-123',
				hash: '',
				assign: vi.fn(),
			},
		})
		render(<SignupPage />)
		expect(localStorage.getItem('maskin_pending_prompt')).toBe('Help me')
		expect(localStorage.getItem('maskin_anon_id')).toBe('anon-123')
	})

	// The remaining post-signup side effects (analytics, landing-page handoff)
	// now fire from completeFromRedirect()'s resolved result, not synchronously
	// after form submit — the actual account isn't created until the user
	// clicks the magic-link email and lands back here on a later page load.
	describe('post-redirect completion (completeFromRedirect resolves on mount)', () => {
		it('emits signup_form_submitted with user_id + completed:true for a brand-new actor', async () => {
			mockCompleteFromRedirect.mockResolvedValue({ id: 'actor-1', is_new_actor: true })
			render(<SignupPage />)
			await waitFor(() => {
				expect(trackEvent).toHaveBeenCalledWith('signup_form_submitted', {
					user_id: 'actor-1',
					completed: true,
				})
			})
		})

		it('does not emit signup_form_submitted for an existing actor (login, not signup)', async () => {
			mockCompleteFromRedirect.mockResolvedValue({ id: 'actor-1', is_new_actor: false })
			render(<SignupPage />)
			await waitFor(() => expect(mockCompleteFromRedirect).toHaveBeenCalled())
			expect(trackEvent).not.toHaveBeenCalledWith('signup_form_submitted', expect.anything())
		})

		it('does not emit signup_form_submitted when there is no pending redirect (result is null)', async () => {
			mockCompleteFromRedirect.mockResolvedValue(null)
			render(<SignupPage />)
			await waitFor(() => expect(mockCompleteFromRedirect).toHaveBeenCalled())
			expect(trackEvent).not.toHaveBeenCalledWith('signup_form_submitted', expect.anything())
		})

		it('emits signup_complete with anonId when maskin_anon_id is in localStorage', async () => {
			localStorage.setItem('maskin_anon_id', 'anon-landing-abc123')
			vi.mocked(api.landingEvents.emit).mockResolvedValue(undefined)
			mockCompleteFromRedirect.mockResolvedValue({ id: 'actor-1', is_new_actor: true })

			render(<SignupPage />)

			await waitFor(() => {
				expect(api.landingEvents.emit).toHaveBeenCalledWith([
					{ name: 'signup_complete', anonId: 'anon-landing-abc123', props: { fromGuest: true } },
				])
			})
		})

		it('does not emit signup_complete when maskin_anon_id is absent', async () => {
			mockCompleteFromRedirect.mockResolvedValue({ id: 'actor-1', is_new_actor: true })
			render(<SignupPage />)
			await waitFor(() => expect(mockCompleteFromRedirect).toHaveBeenCalled())
			expect(api.landingEvents.emit).not.toHaveBeenCalled()
		})

		it('displays an error if completeFromRedirect itself fails', async () => {
			mockCompleteFromRedirect.mockRejectedValue(new Error('Could not verify vaerksted identity'))
			render(<SignupPage />)
			await waitFor(() => {
				expect(screen.getByText('Could not verify vaerksted identity')).toBeInTheDocument()
			})
		})
	})
})
