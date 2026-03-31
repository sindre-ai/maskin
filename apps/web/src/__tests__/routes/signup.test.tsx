import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const mockSignup = vi.fn()

vi.mock('@/hooks/use-auth', () => ({
	useAuth: () => ({ signup: mockSignup }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: any) => options,
	}
})

import { Route } from '@/routes/signup'

const SignupPage = Route.component as React.FC

describe('SignupPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
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
		let resolveSignup: () => void
		mockSignup.mockReturnValue(new Promise<void>((r) => { resolveSignup = r }))
		const user = userEvent.setup()
		render(<SignupPage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
		await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
		await user.type(screen.getByPlaceholderText('At least 8 characters'), 'password123')
		await user.type(screen.getByPlaceholderText('Repeat your password'), 'password123')
		await user.click(screen.getByRole('button', { name: 'Create account' }))
		expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled()
		resolveSignup!()
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
})
