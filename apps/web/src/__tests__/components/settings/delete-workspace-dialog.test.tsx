import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const mockNavigate = vi.fn()
const mockList = vi.fn()
const mockPreview = vi.fn()
const mockDelete = vi.fn()
const mockAccountPreview = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/api')>()
	return {
		...actual,
		api: {
			workspaces: {
				list: (...a: unknown[]) => mockList(...a),
				deletionPreview: (...a: unknown[]) => mockPreview(...a),
				delete: (...a: unknown[]) => mockDelete(...a),
			},
			account: {
				deletionPreview: (...a: unknown[]) => mockAccountPreview(...a),
				delete: vi.fn(),
			},
		},
	}
})

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return { ...mockTanStackRouter(), useNavigate: () => mockNavigate }
})

import { DeleteWorkspaceDialog } from '@/components/settings/delete-workspace-dialog'

const preview = {
	workspace_id: 'ws-1',
	workspace_name: 'Acme',
	can_delete: true,
	blockers: [],
	other_members: 0,
}

function renderDialog(onOpenChange = vi.fn()) {
	render(
		<DeleteWorkspaceDialog
			workspaceId="ws-1"
			workspaceName="Acme"
			open
			onOpenChange={onOpenChange}
		/>,
		{ wrapper: TestWrapper },
	)
	return onOpenChange
}

async function typeNameAndSubmit() {
	fireEvent.change(await screen.findByLabelText(/Type .* to confirm/), {
		target: { value: 'Acme' },
	})
	fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }))
}

describe('DeleteWorkspaceDialog', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockPreview.mockResolvedValue(preview)
		mockDelete.mockResolvedValue({ deleted: true })
		mockAccountPreview.mockResolvedValue({ can_delete: true, blockers: [], leaving: [] })
	})

	it('keeps the delete button disabled until the exact name is typed', async () => {
		mockList.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }])
		renderDialog()
		const input = await screen.findByLabelText(/Type .* to confirm/)
		const submit = screen.getByRole('button', { name: 'Delete workspace' })
		expect(submit).toBeDisabled()
		fireEvent.change(input, { target: { value: 'acme' } })
		expect(submit).toBeDisabled()
		fireEvent.change(input, { target: { value: 'Acme' } })
		expect(submit).toBeEnabled()
	})

	it('shows blockers and no confirmation field when deletion is not allowed', async () => {
		mockList.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }])
		mockPreview.mockResolvedValue({
			...preview,
			can_delete: false,
			blockers: [{ code: 'cancel_plan', message: 'Cancel the plan first.' }],
		})
		renderDialog()
		expect(await screen.findByText('Cancel the plan first.')).toBeInTheDocument()
		expect(screen.queryByLabelText(/Type .* to confirm/)).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Delete workspace' })).toBeDisabled()
	})

	it('goes straight to the index route when other workspaces remain', async () => {
		mockList.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }])
		renderDialog()
		await typeNameAndSubmit()
		await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/' }))
		expect(screen.queryByText('You have no workspaces left')).not.toBeInTheDocument()
	})

	it('says so when it is the only workspace', async () => {
		mockList.mockResolvedValue([{ id: 'ws-1' }])
		renderDialog()
		expect(await screen.findByText(/This is your only workspace/)).toBeInTheDocument()
	})

	it('asks to delete the account after deleting the last workspace, without navigating yet', async () => {
		mockList.mockResolvedValue([{ id: 'ws-1' }])
		renderDialog()
		await screen.findByText(/This is your only workspace/)
		await typeNameAndSubmit()
		expect(await screen.findByText('You have no workspaces left')).toBeInTheDocument()
		expect(screen.getByText(/Delete your account too\?/)).toBeInTheDocument()
		expect(mockNavigate).not.toHaveBeenCalled()
	})

	it('"Not now" closes the prompt and leaves for the index route', async () => {
		mockList.mockResolvedValue([{ id: 'ws-1' }])
		const onOpenChange = renderDialog()
		await screen.findByText(/This is your only workspace/)
		await typeNameAndSubmit()
		fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
		expect(onOpenChange).toHaveBeenCalledWith(false)
		expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
	})

	it('"Delete account" opens the password dialog', async () => {
		mockList.mockResolvedValue([{ id: 'ws-1' }])
		renderDialog()
		await screen.findByText(/This is your only workspace/)
		await typeNameAndSubmit()
		fireEvent.click(await screen.findByRole('button', { name: 'Delete account' }))
		expect(await screen.findByLabelText('Enter your password to confirm')).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'Delete your account' })).toBeInTheDocument()
	})
})
