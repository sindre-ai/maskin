import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const mockSubmitProfile = vi.fn()
vi.mock('@/hooks/use-vaerksted-auth', () => ({
	useVaerkstedAuth: () => ({ loading: false, submitProfile: mockSubmitProfile }),
}))

const mockGetStoredActor = vi.fn()
vi.mock('@/lib/auth', () => ({
	getStoredActor: () => mockGetStoredActor(),
}))

const mockUseSearch = vi.fn()
vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		useSearch: () => mockUseSearch(),
		Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
	}
})

import { Route } from '@/routes/_authed/complete-profile'

const CompleteProfilePage = (Route as unknown as { component: React.FC }).component

describe('CompleteProfilePage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseSearch.mockReturnValue({ workspace_id: 'ws-1' })
		mockGetStoredActor.mockReturnValue({
			id: 'actor-1',
			name: 'test@example.com',
			type: 'human',
			email: 'test@example.com',
		})
	})

	it('redirects to /login when there is no stored actor (direct navigation, stale bookmark)', () => {
		mockGetStoredActor.mockReturnValue(null)
		render(<CompleteProfilePage />)
		expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/login')
	})

	it('renders the three questions, no email field (already authenticated)', () => {
		render(<CompleteProfilePage />)
		expect(screen.getByText('Complete your profile')).toBeInTheDocument()
		// The greeting text spans two adjacent text nodes (JSX line wrap between
		// the ternary and the literal suffix) — match on combined textContent
		// rather than an exact getByText string.
		expect(
			screen.getByText(
				(_, element) =>
					element?.textContent === 'Signed in as test@example.com — just a couple more details',
			),
		).toBeInTheDocument()
		expect(screen.getByPlaceholderText('Your name')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('Company name')).toBeInTheDocument()
		expect(screen.getByPlaceholderText('What you do')).toBeInTheDocument()
		expect(screen.queryByPlaceholderText('you@example.com')).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
	})

	it('validates name/organization/role before submitting', async () => {
		const user = userEvent.setup()
		render(<CompleteProfilePage />)
		await user.click(screen.getByRole('button', { name: 'Continue' }))
		expect(screen.getByText('Name is required')).toBeInTheDocument()
		expect(mockSubmitProfile).not.toHaveBeenCalled()

		await user.type(screen.getByPlaceholderText('Your name'), 'Ada Lovelace')
		await user.click(screen.getByRole('button', { name: 'Continue' }))
		expect(screen.getByText('Organization is required')).toBeInTheDocument()

		await user.type(screen.getByPlaceholderText('Company name'), 'Analytical Engines')
		await user.click(screen.getByRole('button', { name: 'Continue' }))
		expect(screen.getByText('Role is required')).toBeInTheDocument()
	})

	it('calls submitProfile with the workspace_id from search params and trimmed field values', async () => {
		const user = userEvent.setup()
		render(<CompleteProfilePage />)
		await user.type(screen.getByPlaceholderText('Your name'), '  Ada Lovelace  ')
		await user.type(screen.getByPlaceholderText('Company name'), '  Analytical Engines  ')
		await user.type(screen.getByPlaceholderText('What you do'), '  Mathematician  ')
		await user.click(screen.getByRole('button', { name: 'Continue' }))

		await waitFor(() => {
			expect(mockSubmitProfile).toHaveBeenCalledWith('ws-1', {
				name: 'Ada Lovelace',
				organization: 'Analytical Engines',
				role: 'Mathematician',
			})
		})
	})

	it('displays an error if submitProfile throws', async () => {
		mockSubmitProfile.mockRejectedValue(new Error('Network error'))
		const user = userEvent.setup()
		render(<CompleteProfilePage />)
		await user.type(screen.getByPlaceholderText('Your name'), 'Ada Lovelace')
		await user.type(screen.getByPlaceholderText('Company name'), 'Analytical Engines')
		await user.type(screen.getByPlaceholderText('What you do'), 'Mathematician')
		await user.click(screen.getByRole('button', { name: 'Continue' }))

		await waitFor(() => {
			expect(screen.getByText('Network error')).toBeInTheDocument()
		})
	})
})
