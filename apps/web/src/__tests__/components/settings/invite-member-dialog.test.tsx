import { ApiError } from '@/lib/api'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const mockCreate = vi.fn()
const mockMembersList = vi.fn()
const mockToastSuccess = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/api')>()
	return {
		...actual,
		api: {
			invites: { create: (...args: unknown[]) => mockCreate(...args) },
			workspaces: { members: { list: (...args: unknown[]) => mockMembersList(...args) } },
		},
	}
})

vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => mockToastSuccess(...a) } }))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))

import { InviteMemberDialog } from '@/components/settings/invite-member-dialog'

function renderDialog(onOpenChange = vi.fn()) {
	render(
		<InviteMemberDialog
			open
			onOpenChange={onOpenChange}
			workspaceId="ws-1"
			workspaceName="Værksted"
		/>,
		{ wrapper: TestWrapper },
	)
	return onOpenChange
}

function fillEmail(value: string) {
	fireEvent.change(screen.getByLabelText('Email address'), { target: { value } })
}

describe('InviteMemberDialog', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('offers only Member and Viewer roles, never Owner', async () => {
		renderDialog()
		fireEvent.click(screen.getByRole('combobox', { name: /Role for the new member/ }))
		expect(await screen.findByRole('option', { name: 'Member' })).toBeInTheDocument()
		expect(screen.getByRole('option', { name: 'Viewer' })).toBeInTheDocument()
		expect(screen.queryByRole('option', { name: /Owner/i })).not.toBeInTheDocument()
	})

	it('keeps Send invite disabled until the email is valid, and flags a bad address', () => {
		renderDialog()
		const send = screen.getByRole('button', { name: 'Send invite' })
		expect(send).toBeDisabled()

		fillEmail('ada@example')
		fireEvent.blur(screen.getByLabelText('Email address'))
		expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()
		expect(send).toBeDisabled()

		fillEmail('ada@example.com')
		expect(send).toBeEnabled()
	})

	it('shows the pending toast and closes on Branch B', async () => {
		mockCreate.mockResolvedValue({
			status: 'pending',
			invite: { id: 'i1', email: 'ada@example.com', role: 'member', expiresAt: 'x' },
		})
		const onOpenChange = renderDialog()
		fillEmail('ada@example.com')
		fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))

		await waitFor(() =>
			expect(mockToastSuccess).toHaveBeenCalledWith('Invite sent to ada@example.com.'),
		)
		expect(mockCreate).toHaveBeenCalledWith({
			workspaceId: 'ws-1',
			email: 'ada@example.com',
			role: 'member',
		})
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it('names the linked member in the Branch A toast', async () => {
		mockCreate.mockResolvedValue({
			status: 'linked',
			member: { workspaceId: 'ws-1', actorId: 'a-9', role: 'member' },
		})
		mockMembersList.mockResolvedValue([
			{ actorId: 'a-9', name: 'Ada Lovelace', role: 'member', type: 'human', joinedAt: null },
		])
		renderDialog()
		fillEmail('ada@example.com')
		fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))

		await waitFor(() =>
			expect(mockToastSuccess).toHaveBeenCalledWith('Ada Lovelace added as Member.'),
		)
	})

	it('renders the Branch C message inline on a 409 and keeps the dialog open', async () => {
		mockCreate.mockRejectedValue(new ApiError(409, 'conflict'))
		const onOpenChange = renderDialog()
		fillEmail('ada@example.com')
		fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))

		expect(
			await screen.findByText('ada@example.com is already a member of this workspace.'),
		).toBeInTheDocument()
		expect(mockToastSuccess).not.toHaveBeenCalled()
		expect(onOpenChange).not.toHaveBeenCalledWith(false)
	})

	it('renders the rate-limit message with the Retry-After wait on a 429', async () => {
		const err = new ApiError(429, 'limit')
		err.retryAfter = 14400
		mockCreate.mockRejectedValue(err)
		renderDialog()
		fillEmail('ada@example.com')
		fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))

		expect(
			await screen.findByText(
				'Invite limit reached. 20 invites per day max. Try again in about 4 hours.',
			),
		).toBeInTheDocument()
	})

	it('renders the seat-cap message with an upgrade link on a 403 SEAT_CAP_EXCEEDED', async () => {
		const err = new ApiError(403, 'cap')
		err.code = 'SEAT_CAP_EXCEEDED'
		mockCreate.mockRejectedValue(err)
		renderDialog()
		fillEmail('ada@example.com')
		fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))

		expect(await screen.findByText('Your plan is at capacity.')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Upgrade to add more.' })).toBeInTheDocument()
	})
})
