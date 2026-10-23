import { ApiError } from '@/lib/api'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const mockNavigate = vi.fn()
const mockPreview = vi.fn()
const mockDelete = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/api')>()
	return {
		...actual,
		api: {
			account: {
				deletionPreview: (...a: unknown[]) => mockPreview(...a),
				delete: (...a: unknown[]) => mockDelete(...a),
			},
		},
	}
})

vi.mock('@/lib/auth', () => ({ clearAuth: vi.fn() }))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return { ...mockTanStackRouter(), useNavigate: () => mockNavigate }
})

import { DeleteAccountDialog } from '@/components/profile/delete-account-dialog'

const sole = { workspace_id: 'w1', workspace_name: 'Solo', other_members: 0, will_delete: true }
const shared = { workspace_id: 'w2', workspace_name: 'Team', other_members: 2, will_delete: false }

function renderDialog() {
	render(<DeleteAccountDialog open onOpenChange={vi.fn()} />, { wrapper: TestWrapper })
}

describe('DeleteAccountDialog', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockPreview.mockResolvedValue({ can_delete: true, blockers: [], leaving: [shared, sole] })
		mockDelete.mockResolvedValue({ deleted: true })
	})

	it('lists the workspaces you leave and the ones only you are in', async () => {
		renderDialog()
		expect(await screen.findByText('(2 other members)')).toBeInTheDocument()
		expect(screen.getByRole('checkbox')).toBeInTheDocument()
		expect(screen.getByText('Solo')).toBeInTheDocument()
	})

	it('requires a password before the delete button is enabled', async () => {
		renderDialog()
		const password = await screen.findByLabelText('Enter your password to confirm')
		const submit = screen.getByRole('button', { name: 'Delete account' })
		expect(submit).toBeDisabled()
		fireEvent.change(password, { target: { value: 'secret' } })
		expect(submit).toBeEnabled()
	})

	it('sends the opt-in to delete sole workspaces and navigates to login', async () => {
		renderDialog()
		fireEvent.click(await screen.findByRole('checkbox'))
		fireEvent.change(await screen.findByLabelText('Enter your password to confirm'), {
			target: { value: 'secret' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
		await waitFor(() =>
			expect(mockDelete).toHaveBeenCalledWith({ password: 'secret', delete_sole_workspaces: true }),
		)
		await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' }))
	})

	it('says the password is wrong on a 401 and does not navigate', async () => {
		mockDelete.mockRejectedValue(new ApiError(401, 'Unauthorized'))
		renderDialog()
		fireEvent.change(await screen.findByLabelText('Enter your password to confirm'), {
			target: { value: 'nope' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
		expect(await screen.findByText('Wrong password.')).toBeInTheDocument()
		expect(mockNavigate).not.toHaveBeenCalled()
	})

	it('shows blockers with a link and hides the password field', async () => {
		mockPreview.mockResolvedValue({
			can_delete: false,
			blockers: [{ code: 'cancel_plan', workspace_id: 'w2', workspace_name: 'Team' }],
			leaving: [shared],
		})
		renderDialog()
		expect(await screen.findByRole('link', { name: 'Open billing' })).toBeInTheDocument()
		expect(screen.queryByLabelText('Enter your password to confirm')).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Delete account' })).toBeDisabled()
	})
})
