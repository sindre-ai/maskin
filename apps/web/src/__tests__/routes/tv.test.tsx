import { ApiError } from '@/lib/api'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../setup'

const mockPreview = vi.fn()
const mockApprove = vi.fn()
const mockDeny = vi.fn()
const mockLogin = vi.fn()
const mockGetApiKey = vi.fn()
const mockGetStoredActor = vi.fn()
let searchCode = ''

vi.mock('@tanstack/react-router', () => ({
	createFileRoute: () => (options: Record<string, unknown>) => ({
		...options,
		useSearch: () => ({ code: searchCode }),
	}),
}))

vi.mock('@/lib/api', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/api')>()
	return {
		...actual,
		api: {
			deviceAuth: {
				preview: (...a: unknown[]) => mockPreview(...a),
				approve: (...a: unknown[]) => mockApprove(...a),
				deny: (...a: unknown[]) => mockDeny(...a),
			},
			auth: { login: (...a: unknown[]) => mockLogin(...a) },
		},
	}
})

vi.mock('@/lib/auth', () => ({
	getApiKey: () => mockGetApiKey(),
	getStoredActor: () => mockGetStoredActor(),
	setApiKey: vi.fn(),
	setStoredActor: vi.fn(),
	clearAuth: vi.fn(),
}))

import { Route } from '@/routes/tv'

const TvPage = (Route as unknown as { component: React.FC }).component

function renderPage() {
	render(<TvPage />, { wrapper: TestWrapper })
}

beforeEach(() => {
	vi.clearAllMocks()
	searchCode = ''
	mockGetApiKey.mockReturnValue('ank_test')
	mockGetStoredActor.mockReturnValue({
		id: 'a1',
		name: 'Ada',
		type: 'human',
		email: 'ada@example.com',
	})
	mockPreview.mockResolvedValue({
		client: 'tvos',
		device_name: 'Living Room',
		created_at: '2026-10-08T00:00:00Z',
	})
	mockApprove.mockResolvedValue({ ok: true })
	mockDeny.mockResolvedValue({ ok: true })
})

describe('TvSignInPage', () => {
	it('asks a signed-out visitor to sign in before anything about the TV', () => {
		mockGetApiKey.mockReturnValue(null)
		mockGetStoredActor.mockReturnValue(null)
		renderPage()

		expect(screen.getByText('Sign in your TV')).toBeInTheDocument()
		expect(screen.getByLabelText('Email')).toBeInTheDocument()
		expect(mockPreview).not.toHaveBeenCalled()
	})

	it('groups a typed code like the TV shows it, then names the device before approving', async () => {
		renderPage()
		const input = screen.getByLabelText('Code')
		fireEvent.change(input, { target: { value: 'bcdf2345' } })
		expect(input).toHaveValue('BCDF-2345')

		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		expect(await screen.findByText('Sign in Living Room?')).toBeInTheDocument()
		expect(mockPreview).toHaveBeenCalledWith('BCDF-2345')
		expect(screen.getByText(/ada@example\.com/)).toBeInTheDocument()
		expect(mockApprove).not.toHaveBeenCalled()
	})

	it('goes straight to the question when the code arrives in the link', async () => {
		searchCode = 'bcdf-2345'
		renderPage()

		expect(await screen.findByText('Sign in Living Room?')).toBeInTheDocument()
		expect(mockPreview).toHaveBeenCalledWith('BCDF-2345')
	})

	it('approves only when asked, and says the TV is signing in', async () => {
		searchCode = 'BCDF-2345'
		renderPage()
		fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))

		await waitFor(() => expect(mockApprove).toHaveBeenCalledWith('BCDF-2345'))
		expect(await screen.findByText('Your TV is signing in')).toBeInTheDocument()
	})

	it('refuses a sign-in without approving it', async () => {
		searchCode = 'BCDF-2345'
		renderPage()
		fireEvent.click(await screen.findByRole('button', { name: "This isn't me" }))

		await waitFor(() => expect(mockDeny).toHaveBeenCalledWith('BCDF-2345'))
		expect(mockApprove).not.toHaveBeenCalled()
		expect(await screen.findByText('Sign-in refused')).toBeInTheDocument()
	})

	it('explains an unknown or expired code', async () => {
		mockPreview.mockRejectedValue(new ApiError(404, 'not found'))
		renderPage()
		fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'BCDF2345' } })
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

		expect(await screen.findByText(/isn't valid or has expired/)).toBeInTheDocument()
	})

	it('does not let Continue run until the code is complete', () => {
		renderPage()
		fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'BCDF' } })
		expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
	})
})
