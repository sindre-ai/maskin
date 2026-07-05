import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()
const mockMutateAsync = vi.fn()
let searchValue: { token: string } = { token: '' }

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			useSearch: () => searchValue,
		}),
		useNavigate: () => mockNavigate,
	}
})

vi.mock('@/hooks/use-auth', () => ({
	useVerifyEmailChange: () => ({ mutateAsync: mockMutateAsync }),
}))

import { Route } from '@/routes/verify-email'

const VerifyEmailPage = (Route as unknown as { component: React.FC }).component

describe('VerifyEmailPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		searchValue = { token: '' }
	})

	it('shows an invalid-link message when no token is present', () => {
		searchValue = { token: '' }
		render(<VerifyEmailPage />)
		expect(screen.getByText('Invalid verification link')).toBeInTheDocument()
		expect(mockMutateAsync).not.toHaveBeenCalled()
	})

	it('shows a verifying spinner while the mutation is in flight', () => {
		searchValue = { token: 'abc123' }
		mockMutateAsync.mockReturnValue(new Promise(() => {}))
		render(<VerifyEmailPage />)
		expect(screen.getByText('Verifying your email…')).toBeInTheDocument()
		expect(mockMutateAsync).toHaveBeenCalledWith({ token: 'abc123' })
	})

	it('shows the success state once the mutation resolves', async () => {
		searchValue = { token: 'abc123' }
		mockMutateAsync.mockResolvedValue({ email: 'new@example.com' })
		render(<VerifyEmailPage />)
		await waitFor(() => {
			expect(screen.getByText('Email updated')).toBeInTheDocument()
		})
		expect(screen.getByText('Your account email is now new@example.com.')).toBeInTheDocument()
	})

	it('shows the error message once the mutation rejects', async () => {
		searchValue = { token: 'bad-token' }
		mockMutateAsync.mockRejectedValue(new Error('Verification token is invalid or expired'))
		render(<VerifyEmailPage />)
		await waitFor(() => {
			expect(screen.getByText('Verification failed')).toBeInTheDocument()
		})
		expect(screen.getByText('Verification token is invalid or expired')).toBeInTheDocument()
	})

	it('only calls mutateAsync once even if the effect re-runs', async () => {
		searchValue = { token: 'abc123' }
		mockMutateAsync.mockResolvedValue({ email: 'new@example.com' })
		const { rerender } = render(<VerifyEmailPage />)
		rerender(<VerifyEmailPage />)
		await waitFor(() => {
			expect(screen.getByText('Email updated')).toBeInTheDocument()
		})
		expect(mockMutateAsync).toHaveBeenCalledTimes(1)
	})
})
