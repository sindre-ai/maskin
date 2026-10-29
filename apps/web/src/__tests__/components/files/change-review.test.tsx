import { ChangeReviewLayer } from '@/components/files/change-review'
import { trackChangeReviewOpened } from '@/lib/analytics'
import type { FileDetail, FileProposalDto } from '@/lib/api'
import { api } from '@/lib/api'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/auth', async () => ({
	getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }),
}))

vi.mock('@/lib/analytics', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/analytics')>()),
	trackChangeReviewOpened: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
	const original = await importOriginal<typeof import('@/lib/api')>()
	return {
		...original,
		api: {
			...original.api,
			fileProposals: { listOpen: vi.fn(), accept: vi.fn(), reject: vi.fn() },
		},
	}
})

const TEXT = 'Intro paragraph.\n\nThe quick brown fox.\n\nClosing paragraph.'

const file = {
	id: 'file-1',
	workspaceId: 'ws-1',
	name: 'plan.md',
	mimeType: 'text/markdown',
	encoding: 'utf8',
	content: TEXT,
} as FileDetail

function change(over: Partial<FileProposalDto['changes'][number]> = {}) {
	return {
		id: 'c1',
		ordinal: 0,
		oldText: 'The quick brown fox.',
		newText: 'The slow brown fox.',
		reason: 'More accurate',
		contextBefore: '',
		contextAfter: '',
		status: 'pending' as const,
		decidedBy: null,
		decidedAt: null,
		appliedText: null,
		stale: false,
		...over,
	}
}

function proposal(changes = [change()]): FileProposalDto {
	return {
		id: 'p1',
		fileId: 'file-1',
		author: { id: 'agent-1', name: 'Copywriter', type: 'agent' },
		sessionId: null,
		summary: null,
		fileChangedSinceProposed: false,
		createdAt: '2026-10-29T10:00:00Z',
		changes,
	}
}

function mount(proposals: FileProposalDto[]) {
	vi.mocked(api.fileProposals.listOpen).mockResolvedValue({ proposals })
	return render(
		<ChangeReviewLayer file={file} fileText={TEXT}>
			<div>editor</div>
		</ChangeReviewLayer>,
		{ wrapper: TestWrapper },
	)
}

beforeEach(() => {
	vi.mocked(api.fileProposals.listOpen).mockReset()
	vi.mocked(api.fileProposals.accept).mockReset().mockResolvedValue({})
	vi.mocked(api.fileProposals.reject).mockReset().mockResolvedValue({})
	vi.mocked(trackChangeReviewOpened).mockClear()
})

describe('ChangeReviewLayer', () => {
	it('shows only the editor when no proposal is open', async () => {
		mount([])
		await waitFor(() => expect(api.fileProposals.listOpen).toHaveBeenCalled())
		expect(screen.getByText('editor')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull()
	})

	it('shows the banner above the editor with the agent and the change count', async () => {
		mount([proposal()])
		expect(
			await screen.findByText('Copywriter proposed 1 change to this text.'),
		).toBeInTheDocument()
		expect(screen.getByText('editor')).toBeInTheDocument()
	})

	it('does not count stale or already decided changes', async () => {
		mount([
			proposal([
				change(),
				change({ id: 'c2', stale: true }),
				change({ id: 'c3', status: 'accepted' }),
			]),
		])
		expect(
			await screen.findByText('Copywriter proposed 1 change to this text.'),
		).toBeInTheDocument()
	})

	it('opens the review in place of the editor and sends one change_review_opened event', async () => {
		mount([proposal()])
		fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }))

		expect(screen.queryByText('editor')).toBeNull()
		expect(screen.getByRole('region', { name: 'Change 1' })).toBeInTheDocument()
		expect(screen.getByText('Click Edit to adjust the text before accepting.')).toBeInTheDocument()
		expect(trackChangeReviewOpened).toHaveBeenCalledTimes(1)
		expect(trackChangeReviewOpened).toHaveBeenCalledWith({
			workspace_id: 'ws-1',
			actor_id: 'me',
			file_name: 'plan.md',
			proposal_id: 'p1',
		})
	})

	it('marks removed and added words for screen readers', async () => {
		mount([proposal()])
		fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }))
		const card = screen.getByRole('region', { name: 'Change 1' })
		expect(card.querySelector('del')?.textContent).toContain('removed: quick')
		expect(card.querySelector('ins')?.textContent).toContain('added: slow')
	})

	it('accepts with no applied_text when the proposed text is untouched', async () => {
		mount([proposal()])
		fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }))
		fireEvent.click(screen.getByRole('button', { name: 'Accept' }))

		await waitFor(() =>
			expect(api.fileProposals.accept).toHaveBeenCalledWith(
				'ws-1',
				'file-1',
				'p1',
				'c1',
				undefined,
			),
		)
	})

	it('keeps the card in place until the fade ends, then refetches and ends the review', async () => {
		mount([proposal()])
		fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }))
		vi.mocked(api.fileProposals.listOpen).mockResolvedValue({ proposals: [] })
		fireEvent.click(screen.getByRole('button', { name: 'Accept' }))

		await waitFor(() => expect(api.fileProposals.accept).toHaveBeenCalled())
		// Mid-fade: no refetch yet, so the card is still there.
		expect(api.fileProposals.listOpen).toHaveBeenCalledTimes(1)
		expect(screen.getByRole('region', { name: 'Change 1' })).toBeInTheDocument()

		await waitFor(() => expect(api.fileProposals.listOpen).toHaveBeenCalledTimes(2))
		await waitFor(() => expect(screen.getByText('editor')).toBeInTheDocument())
		expect(screen.queryByRole('region', { name: 'Change 1' })).toBeNull()
	})

	it('sends the edited text as applied_text and shows the edit note', async () => {
		mount([proposal()])
		fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }))
		fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
		fireEvent.change(screen.getByRole('textbox', { name: 'Edit change 1' }), {
			target: { value: 'The slow red fox.' },
		})
		expect(screen.getByText('Your edit will be applied.')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Accept' }))

		await waitFor(() =>
			expect(api.fileProposals.accept).toHaveBeenCalledWith(
				'ws-1',
				'file-1',
				'p1',
				'c1',
				'The slow red fox.',
			),
		)
	})

	it('treats Esc in the textarea as Done and keeps the review open', async () => {
		mount([proposal()])
		fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }))
		fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
		fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit change 1' }), { key: 'Escape' })

		expect(screen.queryByRole('textbox')).toBeNull()
		expect(screen.getByRole('region', { name: 'Change 1' })).toBeInTheDocument()
	})

	it('rejects through the reject endpoint', async () => {
		mount([proposal()])
		fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }))
		fireEvent.click(screen.getByRole('button', { name: 'Reject' }))

		await waitFor(() =>
			expect(api.fileProposals.reject).toHaveBeenCalledWith('ws-1', 'file-1', 'p1', 'c1'),
		)
	})

	it('leaves the review on Esc without deciding', async () => {
		mount([proposal()])
		fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }))
		fireEvent.keyDown(screen.getByRole('region', { name: 'Change 1' }), { key: 'Escape' })

		expect(screen.getByText('editor')).toBeInTheDocument()
		expect(api.fileProposals.accept).not.toHaveBeenCalled()
		expect(api.fileProposals.reject).not.toHaveBeenCalled()
	})
})
