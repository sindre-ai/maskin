import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockSignup = vi.fn()

vi.mock('@/hooks/use-auth', () => ({
	useAuth: () => ({ signup: mockSignup }),
}))

vi.mock('@/lib/api', () => ({
	api: {
		actors: { list: vi.fn() },
		sessions: { create: vi.fn() },
		landingEvents: { emit: vi.fn() },
	},
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

import { api } from '@/lib/api'
import { Route } from '@/routes/signup'

const SignupPage = (Route as unknown as { component: React.FC }).component

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
	await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
	await user.type(screen.getByPlaceholderText('At least 8 characters'), 'password123')
	await user.type(screen.getByPlaceholderText('Repeat your password'), 'password123')
	await user.click(screen.getByRole('button', { name: 'Create account' }))
}

describe('SignupPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		localStorage.clear()
	})

	afterEach(() => {
		localStorage.clear()
	})

	it('renders signup form with all fields', () => {
		render(<SignupPage />)
		expect(screen.getByRole('heading', { name: 'Create account' })).toBeInTheDocument()
		expect(screen.getByPlaceholderText('Your name')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('At least 8 characters')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('Repeat your password')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument()
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

	it('shows "Email is required" when submitting without email', async () => {
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByText('Email is required')).toBeInTheDocument()
	})

	it('shows password length error for short password', async () => {
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
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
		await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
		await user.type(screen.getByPlaceholderText('At least 8 characters'), 'password123')
		await user.type(screen.getByPlaceholderText('Repeat your password'), 'different123')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByText('Passwords do not match')).toBeInTheDocument()
	})

	it('calls signup with correct payload on valid submit', async () => {
		mockSignup.mockResolvedValue(undefined)
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), '  Test User  ')
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

	it('shows loading state during signup', async () => {
		let resolveSignup: (() => void) | undefined
		mockSignup.mockReturnValue(
			new Promise<void>((r) => {
				resolveSignup = r
			}),
		)
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
		await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
		await user.type(screen.getByPlaceholderText('At least 8 characters'), 'password123')
		await user.type(screen.getByPlaceholderText('Repeat your password'), 'password123')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled()
		resolveSignup?.()
	})

	it('displays error message when signup throws', async () => {
		mockSignup.mockRejectedValue(new Error('Email already exists'))
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
		await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
		await user.type(screen.getByPlaceholderText('At least 8 characters'), 'password123')
		await user.type(screen.getByPlaceholderText('Repeat your password'), 'password123')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
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

	it('creates session from pending prompt after signup', async () => {
		localStorage.setItem('maskin_pending_prompt', 'Help me pick the right growth experiment')
		mockSignup.mockResolvedValue({ id: 'actor-1', workspace_id: 'ws-1' })
		vi.mocked(api.actors.list).mockResolvedValue([
			{
				id: 'agent-1',
				type: 'agent',
				name: 'Sindre',
				email: null,
				description: null,
				isSystem: false,
			},
		])
		vi.mocked(api.sessions.create).mockResolvedValue({ id: 'session-1' } as never)

		const user = userEvent.setup()
		render(<SignupPage />)
		await fillAndSubmit(user)

		await waitFor(() => {
			expect(api.sessions.create).toHaveBeenCalledWith('ws-1', {
				actor_id: 'agent-1',
				action_prompt: 'Help me pick the right growth experiment',
				auto_start: true,
			})
		})
		expect(localStorage.getItem('maskin_pending_prompt')).toBeNull()
	})

	it('does not create session when no pending prompt', async () => {
		mockSignup.mockResolvedValue({ id: 'actor-1', workspace_id: 'ws-1' })

		const user = userEvent.setup()
		render(<SignupPage />)
		await fillAndSubmit(user)

		await waitFor(() => expect(mockSignup).toHaveBeenCalled())
		expect(api.sessions.create).not.toHaveBeenCalled()
	})

	it('surfaces error when session creation fails', async () => {
		localStorage.setItem('maskin_pending_prompt', 'some prompt')
		mockSignup.mockResolvedValue({ id: 'actor-1', workspace_id: 'ws-1' })
		vi.mocked(api.actors.list).mockResolvedValue([
			{
				id: 'agent-1',
				type: 'agent',
				name: 'Sindre',
				email: null,
				description: null,
				isSystem: false,
			},
		])
		vi.mocked(api.sessions.create).mockRejectedValue(new Error('session failed'))

		const user = userEvent.setup()
		render(<SignupPage />)
		await fillAndSubmit(user)

		await waitFor(() => expect(screen.getByText('session failed')).toBeInTheDocument())
	})

	it('emits signup_complete with anonId when maskin_anon_id is in localStorage', async () => {
		localStorage.setItem('maskin_anon_id', 'anon-landing-abc123')
		mockSignup.mockResolvedValue({ id: 'actor-1', workspace_id: 'ws-1' })
		vi.mocked(api.landingEvents.emit).mockResolvedValue(undefined)

		const user = userEvent.setup()
		render(<SignupPage />)
		await fillAndSubmit(user)

		await waitFor(() => {
			expect(api.landingEvents.emit).toHaveBeenCalledWith([
				{ name: 'signup_complete', anonId: 'anon-landing-abc123', props: { fromGuest: true } },
			])
		})
		expect(localStorage.getItem('maskin_anon_id')).toBeNull()
	})

	it('does not emit signup_complete when maskin_anon_id is absent', async () => {
		mockSignup.mockResolvedValue({ id: 'actor-1', workspace_id: 'ws-1' })

		const user = userEvent.setup()
		render(<SignupPage />)
		await fillAndSubmit(user)

		await waitFor(() => expect(mockSignup).toHaveBeenCalled())
		expect(api.landingEvents.emit).not.toHaveBeenCalled()
	})
})
