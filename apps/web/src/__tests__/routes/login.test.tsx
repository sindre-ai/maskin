import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const mockSendMagicLink = vi.fn()
const mockCompleteFromRedirect = vi.fn()

vi.mock('@/hooks/use-vaerksted-auth', () => ({
	useVaerkstedAuth: () => ({
		loading: false,
		sendMagicLink: mockSendMagicLink,
		completeFromRedirect: mockCompleteFromRedirect,
	}),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

import { Route } from '@/routes/login'

const LoginPage = (Route as unknown as { component: React.FC }).component

describe('LoginPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockCompleteFromRedirect.mockResolvedValue(null)
	})

	it('renders a vaerksted-only login form: email only, no password field', () => {
		render(<LoginPage />)
		expect(screen.getByText('Welcome back')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument()
		expect(screen.queryByPlaceholderText('Your password')).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
	})

	it('completes the magic-link redirect handshake on mount', () => {
		render(<LoginPage />)
		expect(mockCompleteFromRedirect).toHaveBeenCalledTimes(1)
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
		expect(mockSendMagicLink).not.toHaveBeenCalled()
	})

	it('calls sendMagicLink with trimmed email (no profile — that is signup-only) on valid submit', async () => {
		mockSendMagicLink.mockResolvedValue(undefined)
		const user = userEvent.setup()
		render(<LoginPage />)
		await user.type(screen.getByPlaceholderText('you@example.com'), '  test@example.com  ')
		await user.click(screen.getByRole('button', { name: 'Sign in' }))
		await waitFor(() => {
			expect(mockSendMagicLink).toHaveBeenCalledWith('test@example.com')
		})
	})

	it('shows "Check your email" after a successful send', async () => {
		mockSendMagicLink.mockResolvedValue(undefined)
		const user = userEvent.setup()
		render(<LoginPage />)
		await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
		await user.click(screen.getByRole('button', { name: 'Sign in' }))
		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Check your email' })).toBeDisabled()
		})
	})

	it('displays error message when sendMagicLink throws', async () => {
		mockSendMagicLink.mockRejectedValue(new Error('vaerksted sign-in is not configured'))
		const user = userEvent.setup()
		render(<LoginPage />)
		await user.type(screen.getByPlaceholderText('you@example.com'), 'test@example.com')
		await user.click(screen.getByRole('button', { name: 'Sign in' }))
		await waitFor(() => {
			expect(screen.getByText('vaerksted sign-in is not configured')).toBeInTheDocument()
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
