import { ReviewPanel, type ReviewPanelLayout } from '@/components/files/review-panel'
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
	attachers?: AttachingObject[]
	layout?: ReviewPanelLayout
	lockedDriverType?: 'human' | 'agent'
}

function renderPanel(overrides: Overrides = {}) {
	const queryClient = createTestQueryClient()
	const comments = overrides.comments ?? [legacyPin, freshComment, resolvedComment]
	const drafts = overrides.drafts ?? []
	const provenance = resolveProvenance(overrides.attachers ?? [attacher])
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
					lockedDriverType:
						overrides.sendPhase === 'sent' ? (overrides.lockedDriverType ?? 'human') : null,
				}}
				onSendRound={overrides.onSendRound ?? (() => {})}
				onUpdateDraftBody={() => {}}
				onRemoveDraft={() => {}}
				onPostDraft={() => {}}
				onResolveComment={overrides.onResolveComment ?? (() => {})}
				onReopenComment={() => {}}
				roundFilter={overrides.roundFilter ?? null}
				onClearRoundFilter={() => {}}
				layout={overrides.layout}
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

describe('ReviewPanel — saved-but-unsent comments', () => {
	// A comment that was saved to the server (roundId still null) must stay
	// sendable: Save draft removes the local draft, so the Send rule cannot
	// depend on local drafts alone.
	it('enables Send for a saved comment that has not been sent yet', () => {
		const onSendRound = vi.fn()
		renderPanel({ comments: [freshComment], drafts: [], onSendRound })
		const btn = screen.getByTestId('panel-send-round')
		expect(btn).toBeEnabled()
		fireEvent.click(btn)
		expect(onSendRound).toHaveBeenCalledWith('obj-1')
	})

	it('keeps Send disabled when every comment already belongs to a round', () => {
		renderPanel({ comments: [{ ...freshComment, roundId: 'round-1' }], drafts: [] })
		expect(screen.getByTestId('panel-send-round')).toBeDisabled()
	})
})

// Slice 4 §Remaining viewer states — 4 of 8 states this task ships. The other
// four (empty / loading / file-404 / iframe-blocked) shipped in Slice 1 and
// live on the route + ViewerStage, not this component.
describe('ReviewPanel — Slice 4 viewer states', () => {
	// State: resolved-only-zero — filter is set to Resolved on a file with
	// only open comments. The panel must show a distinct empty state, not the
	// generic "no comments yet" copy (which would misread as "there is
	// nothing here at all", which is not true when there are open comments).
	it('resolved-only-zero renders distinct empty state copy', () => {
		// Only open comments — no resolvedAt on any row.
		const openOnly: FileCommentDto[] = [{ ...legacyPin }, { ...freshComment }]
		const { container } = renderPanel({ filter: 'resolved', comments: openOnly })
		expect(container.querySelector('[data-filter-state="resolved-only-zero"]')).not.toBeNull()
		expect(screen.getByText(/no resolved comments yet/i)).toBeInTheDocument()
		// The generic "click on the stage" invitation is only shown when the
		// file has zero comments at all — it should NOT show here.
		expect(screen.queryByText(/click on the stage to place a pin/i)).toBeNull()
	})

	// Sibling case: filter=Open on a file where everything is already resolved.
	// Verifies the empty-state copy branches on filter, not just resolved-only.
	it('open filter with everything resolved renders "no open comments" copy', () => {
		const resolvedOnly: FileCommentDto[] = [{ ...resolvedComment }]
		const { container } = renderPanel({ filter: 'open', comments: resolvedOnly })
		expect(container.querySelector('[data-filter-state="open-only-zero"]')).not.toBeNull()
		expect(screen.getByText(/no open comments/i)).toBeInTheDocument()
	})

	// With a round filter on, "No open comments" must describe that round, not
	// the whole file: the file can still have open comments in other rounds.
	it('open filter + round filter renders round-scoped "no open comments" copy', () => {
		const comments: FileCommentDto[] = [
			{ ...resolvedComment, roundId: 'round-a' },
			{ ...freshComment, roundId: 'round-b' },
		]
		renderPanel({ filter: 'open', comments, roundFilter: 'round-a' })
		expect(screen.getByText('No open comments in this round')).toBeInTheDocument()
		expect(screen.queryByText(/every comment on this file/i)).toBeNull()
	})

	it('round filter on a round with no comments says so instead of the file-empty copy', () => {
		renderPanel({
			filter: 'open',
			comments: [{ ...freshComment, roundId: 'round-b' }],
			roundFilter: 'round-a',
		})
		expect(screen.getByText('No comments in this round')).toBeInTheDocument()
		expect(screen.queryByText(/click on the stage to place a pin/i)).toBeNull()
	})

	// The default empty state — file with zero comments and zero drafts —
	// keeps the Slice 1 invitation copy. This test pins that the differentiated
	// copy doesn't leak into the truly-empty case.
	it('truly-empty panel keeps Slice 1 "no review comments yet" copy', () => {
		renderPanel({ filter: 'all', comments: [] })
		expect(screen.getByText(/no review comments yet/i)).toBeInTheDocument()
		expect(screen.getByText(/click on the stage to place a pin/i)).toBeInTheDocument()
	})

	// State: draft-in-progress — user has unsent local drafts on the file.
	// The panel surfaces a visible indicator (the Drafts group), and the
	// container's data-viewer-state reflects the state so downstream tests
	// (E2E, screenshot regressions) can pin it.
	it('draft-in-progress state is marked and Drafts group is visible', () => {
		const { container } = renderPanel({ drafts: [draft] })
		expect(container.querySelector('[data-viewer-state="draft-in-progress"]')).not.toBeNull()
		// The group renders its label ("Drafts") and count.
		expect(screen.getByText('Drafts')).toBeInTheDocument()
	})

	// State: archived-parent — attaching object is archived. The panel foot
	// Send is disabled with the "archived" tooltip; the outer container's
	// viewer state reads archived-parent so the row is legible in tests.
	it('archived-parent state marks the panel and disables Send', () => {
		const archivedAttacher: AttachingObject = {
			...attacher,
			archived: true,
		}
		const { container } = renderPanel({ attachers: [archivedAttacher], drafts: [draft] })
		expect(container.querySelector('[data-viewer-state="archived-parent"]')).not.toBeNull()
		const send = screen.getByTestId('panel-send-round')
		expect(send).toBeDisabled()
		expect(send).toHaveAttribute('title', 'The attached object is archived')
	})

	// State: post-send with an agent driver — the sent lock reads
	// "Sent · driver-name" AND surfaces the "🔒 Awaiting agent response"
	// affordance because the round landed on an agent's For You card, not a
	// human's, and the reviewer needs to know the next move belongs to the
	// agent.
	it('post-send with agent driver renders the "Awaiting agent response" affordance', () => {
		renderPanel({ sendPhase: 'sent', lockedDriverType: 'agent' })
		const foot = screen.getByTestId('panel-foot-sent')
		expect(foot).toHaveAttribute('data-viewer-state', 'post-send')
		expect(within(foot).getByText(/Sent · Bob/)).toBeInTheDocument()
		expect(within(foot).getByText(/awaiting agent response/i)).toBeInTheDocument()
	})

	it('post-send with human driver renders lock but no agent affordance', () => {
		renderPanel({ sendPhase: 'sent', lockedDriverType: 'human' })
		const foot = screen.getByTestId('panel-foot-sent')
		expect(foot).toHaveAttribute('data-viewer-state', 'post-send')
		expect(within(foot).getByText(/Sent · Bob/)).toBeInTheDocument()
		expect(within(foot).queryByText(/awaiting agent response/i)).toBeNull()
	})
})

// Slice 4 §Responsive — the panel exposes a `layout` prop that flips the
// container's Tailwind classes so it can slot into either an inline right rail
// (lg+) or a Radix Sheet (below lg, drawer on tablet + bottom sheet on mobile).
// The route owns the breakpoint decision via useIsDesktopViewport /
// useIsMobile; this component just switches its container shape based on the
// prop.
describe('ReviewPanel — Slice 4 responsive layout prop', () => {
	it('layout=inline keeps the fixed 344px width + left border', () => {
		const { container } = renderPanel({ layout: 'inline' })
		const panel = container.querySelector('[data-review-panel]')
		expect(panel?.getAttribute('data-layout')).toBe('inline')
		// The inline shape drops in as a rail with a fixed 344px width.
		expect(panel?.className ?? '').toContain('w-[344px]')
		expect(panel?.className ?? '').toContain('border-l')
	})

	it('layout=sheet drops the fixed width + left border for sheet framing', () => {
		const { container } = renderPanel({ layout: 'sheet' })
		const panel = container.querySelector('[data-review-panel]')
		expect(panel?.getAttribute('data-layout')).toBe('sheet')
		// The sheet shape is edge-to-edge inside the Radix SheetContent — the
		// primitive owns border + width, so the aside goes full-width and
		// drops the left border.
		expect(panel?.className ?? '').toContain('w-full')
		expect(panel?.className ?? '').not.toContain('w-[344px]')
		expect(panel?.className ?? '').not.toContain('border-l')
	})

	it('default layout is inline (backwards-compatible with Slice 3 callers)', () => {
		const { container } = renderPanel({})
		const panel = container.querySelector('[data-review-panel]')
		expect(panel?.getAttribute('data-layout')).toBe('inline')
	})
})
