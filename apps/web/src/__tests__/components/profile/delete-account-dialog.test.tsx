import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()
const mockDelete = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => mockNavigate,
}))

vi.mock('@/lib/api', () => ({
	api: {
		actors: {
			delete: (...args: unknown[]) => mockDelete(...args),
		},
	},
}))

vi.mock('@/lib/auth', () => ({
	clearAuth: vi.fn(),
}))

vi.mock('@/lib/analytics', () => ({
	trackEvent: vi.fn(),
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { DeleteAccountDialog } from '@/components/profile/delete-account-dialog'
import { trackEvent } from '@/lib/analytics'
import { clearAuth } from '@/lib/auth'
import { toast } from 'sonner'
import { TestWrapper } from '../../setup'

beforeEach(() => {
	vi.clearAllMocks()
})

function renderDialog(open = true) {
	const onOpenChange = vi.fn()
	const result = render(
		<DeleteAccountDialog
			open={open}
			onOpenChange={onOpenChange}
			actorId="actor-1"
			workspaceId="ws-1"
		/>,
		{ wrapper: TestWrapper },
	)
	return { onOpenChange, ...result }
}

describe('DeleteAccountDialog', () => {
	it('renders the destruction list and both action buttons when open', () => {
		renderDialog()
		expect(screen.getByRole('dialog')).toBeInTheDocument()
		expect(screen.getByText(/your account, profile, and avatar/i)).toBeInTheDocument()
		expect(screen.getByText(/api keys and active sessions/i)).toBeInTheDocument()
		expect(screen.getByText(/workspaces you solely own/i)).toBeInTheDocument()
		expect(screen.getByText(/comments, decisions, and content you authored/i)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Delete account' })).toBeInTheDocument()
	})

	it('does not render the dialog when closed', () => {
		renderDialog(false)
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
	})

	it('calls the delete endpoint, clears auth, toasts, and navigates to /login on success', async () => {
		mockDelete.mockResolvedValue({ deleted: true })
		const { onOpenChange } = renderDialog()

		fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))

		await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('actor-1', 'ws-1'))
		await waitFor(() => expect(clearAuth).toHaveBeenCalledTimes(1))
		expect(trackEvent).toHaveBeenCalledWith('profile.account_deleted')
		expect(toast.success).toHaveBeenCalledWith('Your account has been deleted')
		expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' })
		// Component does not auto-close; the navigate unmounts the route. We still
		// assert it did not flip `open` off — the route boundary owns that.
		expect(onOpenChange).not.toHaveBeenCalled()
	})

	it('surfaces an error toast and keeps the dialog open on a delete failure', async () => {
		mockDelete.mockRejectedValue(new Error('Boom'))
		renderDialog()

		fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))

		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Boom'))
		expect(clearAuth).not.toHaveBeenCalled()
		expect(mockNavigate).not.toHaveBeenCalled()
		expect(screen.getByRole('dialog')).toBeInTheDocument()
	})

	it('closes via Cancel without calling the delete endpoint', () => {
		const { onOpenChange } = renderDialog()
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		expect(onOpenChange).toHaveBeenCalledWith(false)
		expect(mockDelete).not.toHaveBeenCalled()
	})
})
