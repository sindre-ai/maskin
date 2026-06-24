import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSignup = vi.fn()

vi.mock('@/hooks/use-auth', () => ({
	useAuth: () => ({ signup: mockSignup }),
}))

vi.mock('@/lib/api', () => ({
	api: {
		landingEvents: { emit: vi.fn() },
		publicBetStrategist: { claim: vi.fn() },
		objects: { create: vi.fn() },
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

const ASSIGN_PATH = '/'

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
	await user.type(screen.getByPlaceholderText('Company name'), 'Test Co')
	await user.type(screen.getByPlaceholderText('What you do'), 'Founder')
	await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
	await user.type(screen.getByPlaceholderText('At least 8 characters'), 'password123')
	await user.type(screen.getByPlaceholderText('Repeat your password'), 'password123')
	await user.click(screen.getByRole('button', { name: 'Create account' }))
}

describe('SignupPage', () => {
	const originalLocation = window.location

	beforeEach(() => {
		vi.clearAllMocks()
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

	it('renders signup form with all fields', () => {
		render(<SignupPage />)
		expect(screen.getByRole('heading', { name: 'Create account' })).toBeInTheDocument()
		expect(screen.getByPlaceholderText('Your name')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('Company name')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('What you do')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('At least 8 characters')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('Repeat your password')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument()
	})

	it('emits signup_form_started once when the form first renders', () => {
		render(<SignupPage />)
		expect(trackEvent).toHaveBeenCalledWith('signup_form_started', {})
		expect(
			vi.mocked(trackEvent).mock.calls.filter((c) => c[0] === 'signup_form_started'),
		).toHaveLength(1)
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
		expect(mockSignup).not.toHaveBeenCalled()
	})

	it('shows "Organization is required" when submitting without organization', async () => {
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByText('Organization is required')).toBeInTheDocument()
		expect(mockSignup).not.toHaveBeenCalled()
	})

	it('shows "Role is required" when submitting without role', async () => {
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
		await user.type(screen.getByPlaceholderText('Company name'), 'Test Co')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByText('Role is required')).toBeInTheDocument()
		expect(mockSignup).not.toHaveBeenCalled()
	})

	it('shows "Email is required" when submitting without email', async () => {
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
		await user.type(screen.getByPlaceholderText('Company name'), 'Test Co')
		await user.type(screen.getByPlaceholderText('What you do'), 'Founder')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByText('Email is required')).toBeInTheDocument()
	})

	it('shows password length error for short password', async () => {
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
		await user.type(screen.getByPlaceholderText('Company name'), 'Test Co')
		await user.type(screen.getByPlaceholderText('What you do'), 'Founder')
		await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
		await user.type(screen.getByPlaceholderText('At least 8 characters'), 'short')
		await user.type(screen.getByPlaceholderText('Repeat your password'), 'short')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument()
	})

	it('shows "Passwords do not match" when passwords differ', async () => {
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
		await user.type(screen.getByPlaceholderText('Company name'), 'Test Co')
		await user.type(screen.getByPlaceholderText('What you do'), 'Founder')
		await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
		await user.type(screen.getByPlaceholderText('At least 8 characters'), 'password123')
		await user.type(screen.getByPlaceholderText('Repeat your password'), 'different123')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByText('Passwords do not match')).toBeInTheDocument()
	})

	it('calls signup with correct payload on valid submit', async () => {
		mockSignup.mockResolvedValue({ id: 'actor-1', workspace_id: 'ws-1' })
		vi.mocked(api.objects.create).mockResolvedValue({} as never)
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), '  Test User  ')
		await user.type(screen.getByPlaceholderText('Company name'), 'Test Co')
		await user.type(screen.getByPlaceholderText('What you do'), 'Founder')
		await user.type(screen.getByPlaceholderText('you@example.com'), '  test@example.com  ')
		await user.type(screen.getByPlaceholderText('At least 8 characters'), 'password123')
		await user.type(screen.getByPlaceholderText('Repeat your password'), 'password123')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		await waitFor(() => {
			expect(mockSignup).toHaveBeenCalledWith({
				type: 'human',
				name: 'Test User',
				email: 'test@example.com',
				password: 'password123',
			})
		})
	})

	it('writes the signup capture knowledge object to the new workspace', async () => {
		mockSignup.mockResolvedValue({ id: 'actor-1', workspace_id: 'ws-1' })
		vi.mocked(api.objects.create).mockResolvedValue({} as never)

		const user = userEvent.setup()
		render(<SignupPage />)
		await fillAndSubmit(user)

		await waitFor(() => expect(api.objects.create).toHaveBeenCalledTimes(1))
		const [workspaceId, payload] = vi.mocked(api.objects.create).mock.calls[0]
		expect(workspaceId).toBe('ws-1')
		expect(payload.type).toBe('knowledge')
		expect(payload.title).toBe('Signup context — Test User')
		const meta = payload.metadata as Record<string, unknown>
		expect(meta.source).toBe('signup_capture')
		expect(meta.name).toBe('Test User')
		expect(meta.organization).toBe('Test Co')
		expect(meta.role).toBe('Founder')
	})

	it('emits signup_form_submitted with user_id + completed:true on success', async () => {
		mockSignup.mockResolvedValue({ id: 'actor-1', workspace_id: 'ws-1' })
		vi.mocked(api.objects.create).mockResolvedValue({} as never)

		const user = userEvent.setup()
		render(<SignupPage />)
		await fillAndSubmit(user)

		await waitFor(() => {
			expect(trackEvent).toHaveBeenCalledWith('signup_form_submitted', {
				user_id: 'actor-1',
				completed: true,
			})
		})
	})

	it('still emits signup_form_submitted when the knowledge-object write fails', async () => {
		mockSignup.mockResolvedValue({ id: 'actor-1', workspace_id: 'ws-1' })
		vi.mocked(api.objects.create).mockRejectedValue(new Error('500'))

		const user = userEvent.setup()
		render(<SignupPage />)
		await fillAndSubmit(user)

		await waitFor(() => {
			expect(trackEvent).toHaveBeenCalledWith('signup_form_submitted', {
				user_id: 'actor-1',
				completed: true,
			})
		})
	})

	it('shows loading state during signup', async () => {
		let resolveSignup: ((value: { id: string; workspace_id: string }) => void) | undefined
		mockSignup.mockReturnValue(
			new Promise<{ id: string; workspace_id: string }>((r) => {
				resolveSignup = r
			}),
		)
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
		await user.type(screen.getByPlaceholderText('Company name'), 'Test Co')
		await user.type(screen.getByPlaceholderText('What you do'), 'Founder')
		await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
		await user.type(screen.getByPlaceholderText('At least 8 characters'), 'password123')
		await user.type(screen.getByPlaceholderText('Repeat your password'), 'password123')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled()
		resolveSignup?.({ id: 'actor-1', workspace_id: 'ws-1' })
	})

	it('displays error message when signup throws', async () => {
		mockSignup.mockRejectedValue(new Error('Email already exists'))
		const user = userEvent.setup()
		render(<SignupPage />)
		await fillAndSubmit(user)
		await waitFor(() => {
			expect(screen.getByText('Email already exists')).toBeInTheDocument()
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

	it('leaves pending prompt in localStorage after signup for workspace to handle', async () => {
		localStorage.setItem('maskin_pending_prompt', 'Help me pick the right growth experiment')
		mockSignup.mockResolvedValue({ id: 'actor-1', workspace_id: 'ws-1' })
		vi.mocked(api.objects.create).mockResolvedValue({} as never)

		const user = userEvent.setup()
		render(<SignupPage />)
		await fillAndSubmit(user)

		await waitFor(() => expect(mockSignup).toHaveBeenCalled())
		expect(localStorage.getItem('maskin_pending_prompt')).toBe(
			'Help me pick the right growth experiment',
		)
	})

	it('emits signup_complete with anonId when maskin_anon_id is in localStorage', async () => {
		localStorage.setItem('maskin_anon_id', 'anon-landing-abc123')
		mockSignup.mockResolvedValue({ id: 'actor-1', workspace_id: 'ws-1' })
		vi.mocked(api.objects.create).mockResolvedValue({} as never)
		vi.mocked(api.landingEvents.emit).mockResolvedValue(undefined)

		const user = userEvent.setup()
		render(<SignupPage />)
		await fillAndSubmit(user)

		await waitFor(() => {
			expect(api.landingEvents.emit).toHaveBeenCalledWith([
				{ name: 'signup_complete', anonId: 'anon-landing-abc123', props: { fromGuest: true } },
			])
		})
		expect(localStorage.getItem('maskin_anon_id')).toBe('anon-landing-abc123')
	})

	it('does not emit signup_complete when maskin_anon_id is absent', async () => {
		mockSignup.mockResolvedValue({ id: 'actor-1', workspace_id: 'ws-1' })
		vi.mocked(api.objects.create).mockResolvedValue({} as never)

		const user = userEvent.setup()
		render(<SignupPage />)
		await fillAndSubmit(user)

		await waitFor(() => expect(mockSignup).toHaveBeenCalled())
		expect(api.landingEvents.emit).not.toHaveBeenCalled()
	})
})
