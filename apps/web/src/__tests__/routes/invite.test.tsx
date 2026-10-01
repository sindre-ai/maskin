import { ApiError } from '@/lib/api'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../setup'

const mockPreview = vi.fn()
const mockAccept = vi.fn()
const mockLogin = vi.fn()
const mockGetApiKey = vi.fn()
const mockGetStoredActor = vi.fn()
const mockSetApiKey = vi.fn()
const mockSetStoredActor = vi.fn()
const mockClearAuth = vi.fn()
const assign = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	createFileRoute: () => (options: Record<string, unknown>) => ({
		...options,
		useSearch: () => ({ token: 'tok-123' }),
	}),
}))

vi.mock('@/lib/api', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/api')>()
	return {
		...actual,
		api: {
			invites: {
				preview: (...a: unknown[]) => mockPreview(...a),
				accept: (...a: unknown[]) => mockAccept(...a),
			},
			auth: { login: (...a: unknown[]) => mockLogin(...a) },
		},
	}
})

vi.mock('@/lib/auth', () => ({
	getApiKey: () => mockGetApiKey(),
	getStoredActor: () => mockGetStoredActor(),
	setApiKey: (...a: unknown[]) => mockSetApiKey(...a),
	setStoredActor: (...a: unknown[]) => mockSetStoredActor(...a),
	clearAuth: () => mockClearAuth(),
}))

import { Route } from '@/routes/invite'

const InvitePage = (Route as unknown as { component: React.FC }).component

const PREVIEW = {
	status: 'pending',
	workspaceId: 'ws-9',
	workspaceName: 'Værksted',
	inviterName: 'Sebastian',
	inviteEmail: 'ada@example.com',
	expiresAt: '2026-10-08T00:00:00Z',
}

function renderPage() {
	render(<InvitePage />, { wrapper: TestWrapper })
}

beforeEach(() => {
	vi.clearAllMocks()
	mockPreview.mockResolvedValue(PREVIEW)
	mockGetApiKey.mockReturnValue(null)
	mockGetStoredActor.mockReturnValue(null)
	Object.defineProperty(window, 'location', { value: { assign }, writable: true })
})

describe('InvitePage', () => {
	it('renders the expired message without workspace metadata on a 410', async () => {
		mockPreview.mockRejectedValue(new ApiError(410, 'Gone'))
		renderPage()

		expect(await screen.findByText('This invite has expired')).toBeInTheDocument()
		expect(screen.queryByText(/Værksted/)).not.toBeInTheDocument()
		expect(screen.queryByText(/Sebastian/)).not.toBeInTheDocument()
	})

	it('renders the same expired message on a 404', async () => {
		mockPreview.mockRejectedValue(new ApiError(404, 'Not found'))
		renderPage()
		expect(await screen.findByText('This invite has expired')).toBeInTheDocument()
	})

	describe('sub-branch 1: no account, signed out', () => {
		it('locks the invited email and posts email, password and name to accept', async () => {
			mockAccept.mockResolvedValue({
				actor: {
					id: 'a-1',
					name: 'Ada',
					type: 'human',
					email: 'ada@example.com',
					api_key: 'ank_new',
				},
				workspaceId: 'ws-9',
			})
			renderPage()

			const email = await screen.findByLabelText('Email')
			expect(email).toHaveValue('ada@example.com')
			expect(email).toBeDisabled()

			fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ada Lovelace' } })
			fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } })
			fireEvent.click(screen.getByRole('button', { name: 'Create account & join' }))

			await waitFor(() =>
				expect(mockAccept).toHaveBeenCalledWith('tok-123', {
					email: 'ada@example.com',
					password: 'correct-horse',
					name: 'Ada Lovelace',
				}),
			)
			expect(mockSetApiKey).toHaveBeenCalledWith('ank_new')
			expect(assign).toHaveBeenCalledWith('/ws-9')
		})

		it('rejects a short password before calling the API', async () => {
			renderPage()
			fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'short' } })
			fireEvent.click(screen.getByRole('button', { name: 'Create account & join' }))

			expect(await screen.findByText('Password must be at least 8 characters')).toBeInTheDocument()
			expect(mockAccept).not.toHaveBeenCalled()
		})

		it('switches to sign-in when accept says the account already exists', async () => {
			mockAccept.mockRejectedValue(new ApiError(409, 'An account with this email already exists'))
			renderPage()
			fireEvent.change(await screen.findByLabelText('Password'), {
				target: { value: 'correct-horse' },
			})
			fireEvent.click(screen.getByRole('button', { name: 'Create account & join' }))

			expect(await screen.findByText('Sign in to accept')).toBeInTheDocument()
			expect(screen.getByText(/You already have a Maskin account/)).toBeInTheDocument()
		})
	})

	describe('sub-branch 2: has an account, signed out', () => {
		it('logs in with the invite email, then accepts with no body', async () => {
			mockLogin.mockResolvedValue({
				id: 'a-2',
				name: 'Ada',
				type: 'human',
				email: 'ada@example.com',
				api_key: 'ank_existing',
			})
			mockAccept.mockResolvedValue({ workspaceId: 'ws-9', actorId: 'a-2' })
			renderPage()

			fireEvent.click(await screen.findByRole('button', { name: 'Sign in instead' }))
			fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } })
			fireEvent.click(screen.getByRole('button', { name: 'Sign in & join workspace' }))

			await waitFor(() =>
				expect(mockLogin).toHaveBeenCalledWith({
					email: 'ada@example.com',
					password: 'correct-horse',
				}),
			)
			await waitFor(() => expect(mockAccept).toHaveBeenCalledWith('tok-123'))
			expect(assign).toHaveBeenCalledWith('/ws-9')
		})
	})

	describe('sub-branch 3: signed in, email matches', () => {
		beforeEach(() => {
			mockGetApiKey.mockReturnValue('ank_me')
			mockGetStoredActor.mockReturnValue({
				id: 'a-3',
				name: 'Ada',
				type: 'human',
				email: 'ADA@example.com',
			})
		})

		it('offers one-tap accept and lands in the workspace', async () => {
			mockAccept.mockResolvedValue({ workspaceId: 'ws-9', actorId: 'a-3' })
			renderPage()

			expect(await screen.findByText('Join Værksted?')).toBeInTheDocument()
			fireEvent.click(screen.getByRole('button', { name: 'Accept invite' }))

			await waitFor(() => expect(mockAccept).toHaveBeenCalledWith('tok-123'))
			expect(assign).toHaveBeenCalledWith('/ws-9')
		})

		it('shows the full-workspace state and keeps the invite pending on a seat-cap 403', async () => {
			const err = new ApiError(403, 'cap')
			err.code = 'SEAT_CAP_EXCEEDED'
			mockAccept.mockRejectedValue(err)
			renderPage()
			fireEvent.click(await screen.findByRole('button', { name: 'Accept invite' }))

			expect(await screen.findByText('Værksted is at capacity')).toBeInTheDocument()
			expect(assign).not.toHaveBeenCalled()
		})
	})

	describe('sub-branch 4: signed in, email differs', () => {
		beforeEach(() => {
			mockGetApiKey.mockReturnValue('ank_me')
			mockGetStoredActor.mockReturnValue({
				id: 'a-4',
				name: 'Ada',
				type: 'human',
				email: 'ada@work.com',
			})
		})

		it('shows both addresses and accepts as the current actor', async () => {
			mockAccept.mockResolvedValue({ workspaceId: 'ws-9', actorId: 'a-4' })
			renderPage()

			expect(await screen.findByText('Different email on this invite')).toBeInTheDocument()
			expect(screen.getAllByText('ada@example.com').length).toBeGreaterThan(0)
			fireEvent.click(screen.getByRole('button', { name: 'Accept as ada@work.com' }))

			await waitFor(() => expect(mockAccept).toHaveBeenCalledWith('tok-123'))
		})

		it('signs out to fall back to the sign-up branch', async () => {
			renderPage()
			fireEvent.click(
				await screen.findByRole('button', { name: 'Sign out to use ada@example.com' }),
			)

			expect(mockClearAuth).toHaveBeenCalled()
		})
	})
})
