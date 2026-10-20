import { GmailDraftsDialog } from '@/components/integrations/gmail-drafts-dialog'
import type { GmailDraft } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/api')>()),
	api: { integrations: { gmailDrafts: vi.fn(), gmailSendDraft: vi.fn() } },
}))

import { ApiError, api } from '@/lib/api'

const DRAFT: GmailDraft = {
	draft_id: 'draft-1',
	message_id: 'msg-1',
	thread_id: null,
	to: 'ada@example.com',
	cc: '',
	subject: 'Intro from Maskin',
	snippet: 'Hi Ada',
}

function renderDialog() {
	return render(<GmailDraftsDialog workspaceId="ws-1" open onClose={vi.fn()} />, {
		wrapper: TestWrapper,
	})
}

beforeEach(() => {
	vi.mocked(api.integrations.gmailDrafts).mockReset()
	vi.mocked(api.integrations.gmailSendDraft).mockReset()
	vi.mocked(api.integrations.gmailDrafts).mockResolvedValue({ drafts: [DRAFT] })
})

describe('GmailDraftsDialog', () => {
	it('lists a draft with its recipient and subject', async () => {
		renderDialog()

		expect(await screen.findByText('Intro from Maskin')).toBeInTheDocument()
		expect(screen.getByText('To ada@example.com')).toBeInTheDocument()
	})

	it('asks before sending and sends nothing on the first click', async () => {
		renderDialog()
		await userEvent.click(await screen.findByRole('button', { name: 'Send' }))

		expect(screen.getByText(/Send this to ada@example.com/)).toBeInTheDocument()
		expect(api.integrations.gmailSendDraft).not.toHaveBeenCalled()
	})

	it('sends the version of the draft that was shown once confirmed', async () => {
		vi.mocked(api.integrations.gmailSendDraft).mockResolvedValue({
			message_id: 'sent-1',
			thread_id: null,
		})
		renderDialog()

		await userEvent.click(await screen.findByRole('button', { name: 'Send' }))
		await userEvent.click(screen.getByRole('button', { name: 'Send email' }))

		await waitFor(() =>
			expect(api.integrations.gmailSendDraft).toHaveBeenCalledWith('ws-1', 'draft-1', 'msg-1'),
		)
	})

	it('sends nothing when the confirm is cancelled', async () => {
		renderDialog()
		await userEvent.click(await screen.findByRole('button', { name: 'Send' }))
		await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

		expect(api.integrations.gmailSendDraft).not.toHaveBeenCalled()
		expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
	})

	it('shows why a send was refused', async () => {
		vi.mocked(api.integrations.gmailSendDraft).mockRejectedValue(
			new ApiError(
				409,
				'The draft was edited after you opened it. Review it again before sending.',
			),
		)
		renderDialog()

		await userEvent.click(await screen.findByRole('button', { name: 'Send' }))
		await userEvent.click(screen.getByRole('button', { name: 'Send email' }))

		expect(await screen.findByText(/edited after you opened it/)).toBeInTheDocument()
	})

	it('disables Send for a draft with no recipient', async () => {
		vi.mocked(api.integrations.gmailDrafts).mockResolvedValue({
			drafts: [{ ...DRAFT, to: '' }],
		})
		renderDialog()

		expect(await screen.findByText('No recipient yet')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
	})

	it('shows an empty state when there are no drafts', async () => {
		vi.mocked(api.integrations.gmailDrafts).mockResolvedValue({ drafts: [] })
		renderDialog()

		expect(await screen.findByText('No drafts')).toBeInTheDocument()
	})
})
