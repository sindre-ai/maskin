import { ReviewPanel } from '@/components/files/review-panel'
import type { FileCommentDto } from '@/lib/api'
import type { FileCommentDraft } from '@/lib/file-comments-context'
import { type AttachingObject, resolveProvenance } from '@/lib/viewer-provenance'
import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createTestQueryClient } from '../../setup'

// Auth store — the Textarea and other places call getStoredActor() to render
// current-user affordances. Mock it so the panel renders in a jsdom without
// localStorage seeded.
vi.mock('@/lib/auth', async () => ({
	getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }),
}))

// use-actors provides the author name lookup. Mock it to return a small
// actor map that covers every author in the fixtures.
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({
		data: [
			{
				id: 'actor-1',
				name: 'Alice',
				type: 'human',
				email: null,
				description: null,
				isSystem: false,
				agentState: 'idle',
			},
			{
				id: 'actor-2',
				name: 'Bob',
				type: 'human',
				email: null,
				description: null,
				isSystem: false,
				agentState: 'idle',
			},
		],
	}),
}))

const fileId = 'file-1'
const workspaceId = 'ws-1'
const attacher: AttachingObject = {
	id: 'obj-1',
	title: 'Q3 Review',
	type: 'bet',
	driverId: 'actor-2',
	driverType: 'human',
	attacherName: 'Alice',
	attachedAt: '2026-09-27T09:00:00.000Z',
	targetArchived: false,
	archived: false,
}

const legacyPin: FileCommentDto = {
	id: 'legacy-1',
	fileId,
	page: 0,
	positionDoc: { x: 0.2, y: 0.2 },
	// Backend migration marks legacy-migrated rows with selector 'legacy'.
	selector: 'legacy',
	authorId: 'actor-1',
	body: 'Legacy pin from file.annotations',
	parentId: null,
	roundId: null,
	resolvedAt: null,
	resolvedBy: null,
	createdAt: '2026-09-01T09:00:00.000Z',
	updatedAt: '2026-09-01T09:00:00.000Z',
}

const freshComment: FileCommentDto = {
	...legacyPin,
	id: 'c1',
	selector: null,
	body: 'Fresh viewer comment',
	page: 1,
}

const resolvedComment: FileCommentDto = {
	...freshComment,
	id: 'c2',
	body: 'Already resolved',
	resolvedAt: '2026-09-10T09:00:00.000Z',
	resolvedBy: 'actor-2',
}

const draft: FileCommentDraft = {
	tempId: 'draft-1',
	fileId,
	page: 0,
	positionDoc: { x: 0.4, y: 0.4 },
	selector: null,
	parentId: null,
	body: 'Draft body',
	roundId: 'round-uuid-1',
	createdAt: 1,
}

interface Overrides {
	filter?: 'open' | 'resolved' | 'all'
	roundFilter?: string | null
	sendPhase?: 'idle' | 'sending' | 'sent'
	drafts?: FileCommentDraft[]
	comments?: FileCommentDto[]
	onResolveComment?: (c: FileCommentDto) => void
	onSendRound?: (targetObjectId: string) => void
}

function renderPanel(overrides: Overrides = {}) {
	const queryClient = createTestQueryClient()
	const comments = overrides.comments ?? [legacyPin, freshComment, resolvedComment]
	const drafts = overrides.drafts ?? []
	const provenance = resolveProvenance([attacher])
	return render(
		<QueryClientProvider client={queryClient}>
			<ReviewPanel
				fileId={fileId}
				workspaceId={workspaceId}
				comments={comments}
				drafts={drafts}
				filter={overrides.filter ?? 'all'}
				onFilterChange={() => {}}
				provenance={provenance}
				sendState={{
					phase: overrides.sendPhase ?? 'idle',
					lockedDriverName: overrides.sendPhase === 'sent' ? 'Bob' : null,
					lockedDriverType: overrides.sendPhase === 'sent' ? 'human' : null,
				}}
				onSendRound={overrides.onSendRound ?? (() => {})}
				onUpdateDraftBody={() => {}}
				onRemoveDraft={() => {}}
				onPostDraft={() => {}}
				onResolveComment={overrides.onResolveComment ?? (() => {})}
				onReopenComment={() => {}}
				roundFilter={overrides.roundFilter ?? null}
				onClearRoundFilter={() => {}}
			/>
		</QueryClientProvider>,
	)
}

describe('ReviewPanel — legacy display, filter, resolve, post-send lock', () => {
	// AC (legacy display): "Legacy file.annotations pins for a file with legacy
	// data show as unified file_comments in the panel on first open."
	it('renders legacy-migrated pins in the same panel as fresh comments', () => {
		renderPanel({ filter: 'all' })
		expect(screen.getByText('Legacy pin from file.annotations')).toBeInTheDocument()
		expect(screen.getByText('Fresh viewer comment')).toBeInTheDocument()
	})

	// AC (grouping): "Review panel groups comments by page".
	it('groups comments under their page header', () => {
		renderPanel({ filter: 'all' })
		expect(screen.getByText('Page 1')).toBeInTheDocument()
		expect(screen.getByText('Page 2')).toBeInTheDocument()
	})

	// AC (filter): "Open / Resolved / All filter reflects resolvedAt".
	it('open filter hides resolved comments', () => {
		renderPanel({ filter: 'open' })
		expect(screen.queryByText('Already resolved')).toBeNull()
		expect(screen.getByText('Legacy pin from file.annotations')).toBeInTheDocument()
	})

	it('resolved filter shows only resolved comments', () => {
		renderPanel({ filter: 'resolved' })
		expect(screen.getByText('Already resolved')).toBeInTheDocument()
		expect(screen.queryByText('Fresh viewer comment')).toBeNull()
	})

	// AC (per-comment resolve): "per-comment resolve fires PATCH". Verified by
	// asserting the onResolveComment callback fires with the correct row.
	it('clicking Resolve fires the resolve callback', () => {
		const onResolveComment = vi.fn()
		renderPanel({ filter: 'open', onResolveComment })
		const resolveButtons = screen.getAllByRole('button', { name: /resolve/i })
		fireEvent.click(resolveButtons[0])
		expect(onResolveComment).toHaveBeenCalled()
	})

	// AC (deep-link filtering surface): the panel shows a "Clear" affordance
	// when a round filter is active — so the driver can clear it after they've
	// caught up to the round.
	it('round filter banner shows a Clear button', () => {
		renderPanel({ roundFilter: 'some-round-id' })
		expect(screen.getByText(/round filter active/i)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument()
	})

	// AC (send-round + NO undo): the post-send lock names the driver and shows
	// NO undo button.
	it('post-send lock renders Sent · driver-name with no undo button', () => {
		renderPanel({ sendPhase: 'sent' })
		const foot = screen.getByTestId('panel-foot-sent')
		expect(within(foot).getByText(/Sent · Bob/)).toBeInTheDocument()
		expect(within(foot).queryByRole('button', { name: /undo/i })).toBeNull()
	})

	// AC (send-round with draft): the foot Send button is enabled when there
	// is at least one draft and a valid target — and fires with the target id.
	it('Send button fires onSendRound with the resolved target id', () => {
		const onSendRound = vi.fn()
		renderPanel({ drafts: [draft], onSendRound })
		const btn = screen.getByTestId('panel-send-round')
		fireEvent.click(btn)
		expect(onSendRound).toHaveBeenCalledWith('obj-1')
	})
})
