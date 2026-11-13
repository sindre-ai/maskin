import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const mockForgotPassword = vi.fn()

vi.mock('@/lib/api', () => ({
	api: { auth: { forgotPassword: (...args: unknown[]) => mockForgotPassword(...args) } },
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

import { Route } from '@/routes/forgot-password'

const ForgotPasswordPage = (Route as unknown as { component: React.FC }).component

describe('ForgotPasswordPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('asks for an email before sending', async () => {
		const user = userEvent.setup()
		render(<ForgotPasswordPage />)
		await user.click(screen.getByRole('button', { name: 'Send reset link' }))
		expect(screen.getByText('Email is required')).toBeInTheDocument()
		expect(mockForgotPassword).not.toHaveBeenCalled()
	})

	it('sends the trimmed email and shows the neutral message', async () => {
		mockForgotPassword.mockResolvedValue({ ok: true })
		const user = userEvent.setup()
		render(<ForgotPasswordPage />)
		await user.type(screen.getByPlaceholderText('you@example.com'), ' a@example.com ')
		await user.click(screen.getByRole('button', { name: 'Send reset link' }))
		await waitFor(() =>
			expect(screen.getByText('If that email has an account, we sent a link.')).toBeInTheDocument(),
		)
		expect(mockForgotPassword).toHaveBeenCalledWith('a@example.com')
	})

	it('shows a retry message when the request fails', async () => {
		mockForgotPassword.mockRejectedValue(new Error('boom'))
		const user = userEvent.setup()
		render(<ForgotPasswordPage />)
		await user.type(screen.getByPlaceholderText('you@example.com'), 'a@example.com')
		await user.click(screen.getByRole('button', { name: 'Send reset link' }))
		await waitFor(() => expect(screen.getByText(/Something went wrong/)).toBeInTheDocument())
	})
})
