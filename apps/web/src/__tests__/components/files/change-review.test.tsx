import { ChangeReviewLayer } from '@/components/files/change-review'
import { trackChangeReviewOpened } from '@/lib/analytics'
import type { FileDetail, FileProposalDto } from '@/lib/api'
import { ApiError, api } from '@/lib/api'
import { useChangeApplied } from '@/lib/change-applied-context'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
			fileProposals: {
				listOpen: vi.fn(),
				accept: vi.fn(),
				reject: vi.fn(),
				acceptAll: vi.fn(),
				rejectAll: vi.fn(),
			},
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
	vi.mocked(api.fileProposals.acceptAll).mockReset().mockResolvedValue({})
	vi.mocked(api.fileProposals.rejectAll).mockReset().mockResolvedValue({})
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

	it('counts stale changes but not already decided ones', async () => {
		mount([
			proposal([
				change(),
				change({ id: 'c2', stale: true }),
				change({ id: 'c3', status: 'accepted' }),
			]),
		])
		expect(
			await screen.findByText('Copywriter proposed 2 changes to this text.'),
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

const TWO = [
	change(),
	change({
		id: 'c2',
		ordinal: 1,
		oldText: 'Closing paragraph.',
		newText: 'Final paragraph.',
		reason: null,
	}),
]

async function openReview(changes = TWO) {
	mount([proposal(changes)])
	fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }))
}

describe('Accept all and Reject all', () => {
	it('shows a sticky bar with the count, the agent and a close button', async () => {
		await openReview()
		const bar = screen.getByRole('region', { name: 'Review actions' })
		expect(bar).toHaveTextContent('2 changes from Copywriter')
		expect(screen.getByRole('button', { name: 'Reject all' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Accept all' })).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: 'Leave review without deciding' }),
		).toBeInTheDocument()
	})

	it('leaves the review from the close button without deciding, and the banner stays', async () => {
		await openReview()
		fireEvent.click(screen.getByRole('button', { name: 'Leave review without deciding' }))

		expect(screen.getByText('editor')).toBeInTheDocument()
		expect(screen.getByText('Copywriter proposed 2 changes to this text.')).toBeInTheDocument()
		expect(api.fileProposals.acceptAll).not.toHaveBeenCalled()
		expect(api.fileProposals.rejectAll).not.toHaveBeenCalled()
	})

	it('accepts every pending change in one call and ends the review', async () => {
		await openReview()
		vi.mocked(api.fileProposals.listOpen).mockResolvedValue({ proposals: [] })
		fireEvent.click(screen.getByRole('button', { name: 'Accept all' }))

		await waitFor(() =>
			expect(api.fileProposals.acceptAll).toHaveBeenCalledWith('ws-1', 'file-1', 'p1', [
				'c1',
				'c2',
			]),
		)
		await waitFor(() => expect(screen.getByText('editor')).toBeInTheDocument())
		expect(api.fileProposals.accept).not.toHaveBeenCalled()
	})

	it('rejects every pending change in one call', async () => {
		await openReview()
		vi.mocked(api.fileProposals.listOpen).mockResolvedValue({ proposals: [] })
		fireEvent.click(screen.getByRole('button', { name: 'Reject all' }))

		await waitFor(() =>
			expect(api.fileProposals.rejectAll).toHaveBeenCalledWith('ws-1', 'file-1', 'p1', [
				'c1',
				'c2',
			]),
		)
		await waitFor(() => expect(screen.getByText('editor')).toBeInTheDocument())
	})

	it('keeps Accept all enabled with a stale card and, when the server refuses, marks only the stale ones', async () => {
		await openReview([change(), change({ id: 'c2', ordinal: 1, oldText: 'Gone', stale: true })])
		expect(screen.getByRole('button', { name: 'Accept all' })).toBeEnabled()

		const refusal = new ApiError(409, 'Some changes no longer match the file')
		refusal.staleChangeIds = ['c2']
		vi.mocked(api.fileProposals.acceptAll).mockRejectedValue(refusal)
		fireEvent.click(screen.getByRole('button', { name: 'Accept all' }))

		await waitFor(() => expect(api.fileProposals.acceptAll).toHaveBeenCalled())
		// The first card is still open and pending; the count in the bar is unchanged.
		await waitFor(() => expect(screen.getByRole('button', { name: 'Accept all' })).toBeEnabled())
		expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled()
		expect(screen.getByRole('region', { name: 'Review actions' })).toHaveTextContent('2 changes')
		expect(screen.queryByText('editor')).toBeNull()
	})

	it('marks a change stale when the server refuses Accept all for it, and moves focus to its Reject', async () => {
		await openReview()
		expect(screen.queryByText('The text this change applies to has been edited since.')).toBeNull()

		const refusal = new ApiError(409, 'Some changes no longer match the file')
		refusal.staleChangeIds = ['c2']
		vi.mocked(api.fileProposals.acceptAll).mockRejectedValue(refusal)
		fireEvent.click(screen.getByRole('button', { name: 'Accept all' }))

		const note = await screen.findByText('The text this change applies to has been edited since.')
		expect(note).toHaveAttribute('role', 'alert')
		const stale = screen.getByRole('region', { name: 'Change 2' })
		await waitFor(() => expect(within(stale).getByRole('button', { name: 'Reject' })).toHaveFocus())
		// Change 1 stays pending with a working Accept.
		const open = screen.getByRole('region', { name: 'Change 1' })
		expect(within(open).getByRole('button', { name: 'Accept' })).toBeEnabled()
	})
})

describe('stale and failed cards', () => {
	const staleChange = change({ id: 'c2', ordinal: 1, oldText: 'Gone', stale: true })

	it('shows a stale change as muted text with Accept disabled in the tab order, and Reject working', async () => {
		await openReview([staleChange])
		const card = screen.getByRole('region', { name: 'Change 1' })

		expect(card.querySelector('del, ins')).toBeNull()
		expect(within(card).getByText('The slow brown fox.')).toBeInTheDocument()
		expect(
			within(card).getByText('The text this change applies to has been edited since.'),
		).toBeInTheDocument()
		const accept = within(card).getByRole('button', { name: "Can't apply" })
		expect(accept).toHaveAttribute('aria-disabled', 'true')
		expect(accept).not.toBeDisabled()
		fireEvent.click(accept)
		expect(api.fileProposals.accept).not.toHaveBeenCalled()

		fireEvent.click(within(card).getByRole('button', { name: 'Reject' }))
		await waitFor(() =>
			expect(api.fileProposals.reject).toHaveBeenCalledWith('ws-1', 'file-1', 'p1', 'c2'),
		)
	})

	it('shows an alert row and a Retry button when Accept fails, and Retry accepts again', async () => {
		await openReview([change()])
		vi.mocked(api.fileProposals.accept).mockRejectedValueOnce(new ApiError(500, 'boom'))
		fireEvent.click(screen.getByRole('button', { name: 'Accept' }))

		const alert = await screen.findByRole('alert')
		expect(alert).toHaveTextContent("Couldn't apply this change. Try again.")
		const retry = screen.getByRole('button', { name: 'Retry' })

		vi.mocked(api.fileProposals.listOpen).mockResolvedValue({ proposals: [] })
		fireEvent.click(retry)
		await waitFor(() => expect(api.fileProposals.accept).toHaveBeenCalledTimes(2))
		await waitFor(() => expect(screen.getByText('editor')).toBeInTheDocument())
	})

	it('marks a single Accept stale when the server says that change no longer matches', async () => {
		await openReview([change()])
		const refusal = new ApiError(409, 'A change no longer matches the file')
		refusal.staleChangeIds = ['c1']
		vi.mocked(api.fileProposals.accept).mockRejectedValueOnce(refusal)
		fireEvent.click(screen.getByRole('button', { name: 'Accept' }))

		expect(await screen.findByRole('button', { name: "Can't apply" })).toBeInTheDocument()
	})
})

describe('Change applied', () => {
	function StatusLine() {
		const applied = useChangeApplied()
		return <output>{applied?.applied ? 'Change applied' : 'idle'}</output>
	}

	it('tells the editor a change was applied once the review closes after an accept', async () => {
		vi.mocked(api.fileProposals.listOpen).mockResolvedValue({ proposals: [proposal()] })
		render(
			<ChangeReviewLayer file={file} fileText={TEXT}>
				<StatusLine />
			</ChangeReviewLayer>,
			{ wrapper: TestWrapper },
		)
		expect(await screen.findByText('idle')).toBeInTheDocument()
		fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }))
		vi.mocked(api.fileProposals.listOpen).mockResolvedValue({ proposals: [] })
		fireEvent.click(screen.getByRole('button', { name: 'Accept' }))

		expect(await screen.findByText('Change applied')).toBeInTheDocument()
	})

	it('does not say Change applied after a reject', async () => {
		vi.mocked(api.fileProposals.listOpen).mockResolvedValue({ proposals: [proposal()] })
		render(
			<ChangeReviewLayer file={file} fileText={TEXT}>
				<StatusLine />
			</ChangeReviewLayer>,
			{ wrapper: TestWrapper },
		)
		fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }))
		vi.mocked(api.fileProposals.listOpen).mockResolvedValue({ proposals: [] })
		fireEvent.click(screen.getByRole('button', { name: 'Reject' }))

		await waitFor(() => expect(api.fileProposals.reject).toHaveBeenCalled())
		expect(await screen.findByText('idle')).toBeInTheDocument()
	})
})
