import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const mockLogin = vi.fn()

vi.mock('@/hooks/use-auth', () => ({
	useAuth: () => ({ login: mockLogin }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: any) => options,
	}
})

import { Route } from '@/routes/login'

const LoginPage = Route.component as React.FC

describe('LoginPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders login form with email and password fields', () => {
		render(<LoginPage />)
		expect(screen.getByText('Welcome back')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('Your password')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
	})

	it('renders link to signup page', () => {
		render(<LoginPage />)
		expect(screen.getByText('Sign up')).toBeInTheDocument()
	})

	it('shows "Email is required" when submitting empty email', async () => {
		const user = userEvent.setup()
		render(<LoginPage />)
		await user.click(screen.getByRole('button', { name: 'Sign in' }))
		expect(screen.getByText('Email is required')).toBeInTheDocument()
		expect(mockLogin).not.toHaveBeenCalled()
	})

	it('shows "Password is required" when submitting with email but no password', async () => {
		const user = userEvent.setup()
		render(<LoginPage />)
		await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
		await user.click(screen.getByRole('button', { name: 'Sign in' }))
		expect(screen.getByText('Password is required')).toBeInTheDocument()
		expect(mockLogin).not.toHaveBeenCalled()
	})

	it('calls login with trimmed email and password on valid submit', async () => {
		mockLogin.mockResolvedValue(undefined)
		const user = userEvent.setup()
		render(<LoginPage />)
		await user.type(screen.getByPlaceholderText('you@example.com'), '  test@example.com  ')
		await user.type(screen.getByPlaceholderText('Your password'), 'secret123')
		await user.click(screen.getByRole('button', { name: 'Sign in' }))
		await waitFor(() => {
			expect(mockLogin).toHaveBeenCalledWith({
				email: 'test@example.com',
				password: 'secret123',
			})
		})
	})

	it('shows loading state while login is in progress', async () => {
		let resolveLogin: () => void
		mockLogin.mockReturnValue(new Promise<void>((r) => { resolveLogin = r }))
		const user = userEvent.setup()
		render(<LoginPage />)
		await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
		await user.type(screen.getByPlaceholderText('Your password'), 'secret')
		await user.click(screen.getByRole('button', { name: 'Sign in' }))
		expect(screen.getByRole('button', { name: 'Signing in...' })).toBeDisabled()
		resolveLogin!()
	})

	it('displays error message when login throws', async () => {
		mockLogin.mockRejectedValue(new Error('Invalid credentials'))
		const user = userEvent.setup()
		render(<LoginPage />)
		await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
		await user.type(screen.getByPlaceholderText('Your password'), 'wrong')
		await user.click(screen.getByRole('button', { name: 'Sign in' }))
		await waitFor(() => {
			expect(screen.getByText('Invalid credentials')).toBeInTheDocument()
		})
	})

	it('clears error when user types in email field', async () => {
		const user = userEvent.setup()
		render(<LoginPage />)
		await user.click(screen.getByRole('button', { name: 'Sign in' }))
		expect(screen.getByText('Email is required')).toBeInTheDocument()
		await user.type(screen.getByPlaceholderText('you@example.com'), 'a')
		expect(screen.queryByText('Email is required')).not.toBeInTheDocument()
	})
})
