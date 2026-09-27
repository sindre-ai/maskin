import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useActors } from '@/hooks/use-actors'
import type { ActorListItem, FileCommentDto } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import type { FileCommentDraft } from '@/lib/file-comments-context'
import type { AttachingObject, ProvenanceResolution } from '@/lib/viewer-provenance'
import { Check } from 'lucide-react'
import { useMemo, useState } from 'react'

// The review panel — 344px fixed-width right rail, per spec §Solution sketch.
// Owns:
// - Filter (Open / Resolved / All) driven by resolvedAt.
// - Grouping by `page` (spec: "Comments grouped under the page they sit on").
// - Threading via `parentId`. Panel-only per no-gos (no inline-on-stage reply).
// - Per-comment resolve via a PATCH mutation the parent hook exposes.
// - Draft cards for as-yet-unsent client drafts (from FileCommentsProvider).
// - Send-round foot, with a locked "Sent · driver-name" state after send.
//   Send is final: no reversal affordance, no timer, no cancel button. Sebk
//   locked this 2026-09-07; the send-flow grep test pins the invariant to
//   the tree so a later slip can't reintroduce it.

export type ReviewFilter = 'open' | 'resolved' | 'all'

export interface ReviewPanelProps {
	fileId: string
	workspaceId: string
	comments: FileCommentDto[]
	drafts: FileCommentDraft[]
	filter: ReviewFilter
	onFilterChange: (next: ReviewFilter) => void
	provenance: ProvenanceResolution
	// The route builds this so the panel doesn't have to re-resolve provenance
	// or re-fetch actors — the `useAttachingObjects` hook already ran upstream.
	sendState: {
		phase: 'idle' | 'sending' | 'sent'
		// After a successful send the panel foot names the driver in the lock.
		lockedDriverName: string | null
		lockedDriverType: 'human' | 'agent' | null
	}
	// Callbacks
	onSendRound: (targetObjectId: string) => void
	onUpdateDraftBody: (tempId: string, body: string) => void
	onRemoveDraft: (tempId: string) => void
	onPostDraft: (draft: FileCommentDraft) => void
	onResolveComment: (comment: FileCommentDto) => void
	onReopenComment: (comment: FileCommentDto) => void
	// When set, the panel filters to comments carrying this roundId (spec:
	// "?round=<id>&panel=open opens the viewer with the review panel filtered
	// to that round").
	roundFilter: string | null
	onClearRoundFilter: () => void
}

const FILTER_LABELS: Record<ReviewFilter, string> = {
	open: 'Open',
	resolved: 'Resolved',
	all: 'All',
}

export function ReviewPanel(props: ReviewPanelProps) {
	const {
		fileId,
		workspaceId,
		comments,
		drafts,
		filter,
		onFilterChange,
		provenance,
		sendState,
		onSendRound,
		onUpdateDraftBody,
		onRemoveDraft,
		onPostDraft,
		onResolveComment,
		onReopenComment,
		roundFilter,
		onClearRoundFilter,
	} = props

	const { data: actors } = useActors(workspaceId, { enabled: true })
	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const a of actors ?? []) map.set(a.id, a)
		return map
	}, [actors])

	const { open, resolved } = useMemo(() => {
		let openCount = 0
		let resolvedCount = 0
		for (const c of comments) {
			if (c.resolvedAt) resolvedCount++
			else openCount++
		}
		return { open: openCount, resolved: resolvedCount }
	}, [comments])

	const filtered = useMemo(() => {
		let subset = comments
		if (roundFilter) subset = subset.filter((c) => c.roundId === roundFilter)
		if (filter === 'open') subset = subset.filter((c) => !c.resolvedAt)
		else if (filter === 'resolved') subset = subset.filter((c) => c.resolvedAt)
		return subset
	}, [comments, filter, roundFilter])

	// Group by page — comments carrying `page: null` (unpaged files, or legacy
	// pins that lost their page during migration) get their own "No page" bucket
	// pinned at the end.
	const groups = useMemo(() => groupByPage(filtered), [filtered])

	const draftsForFile = useMemo(() => drafts.filter((d) => d.fileId === fileId), [drafts, fileId])

	return (
		<aside
			data-review-panel
			// Fixed 344px is spec — never mobile-first. Mobile-first responsive
			// re-shaping lands in Slice 4 per the task's out-of-scope section.
			className="flex h-full w-[344px] flex-shrink-0 flex-col border-l bg-card"
			aria-label="Review panel"
		>
			<PanelHeader
				filter={filter}
				onFilterChange={onFilterChange}
				open={open}
				resolved={resolved}
				total={comments.length}
				roundFilter={roundFilter}
				onClearRoundFilter={onClearRoundFilter}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{filtered.length === 0 && draftsForFile.length === 0 ? (
					<div className="p-6">
						<EmptyState
							title="No review comments yet"
							description="Click on the stage to place a pin and start a round."
						/>
					</div>
				) : (
					<>
						{groups.map((group) => (
							<PageGroup
								key={group.key}
								group={group}
								actorsById={actorsById}
								onResolve={onResolveComment}
								onReopen={onReopenComment}
							/>
						))}
						{draftsForFile.length > 0 && (
							<DraftGroup
								drafts={draftsForFile}
								onUpdateDraftBody={onUpdateDraftBody}
								onRemoveDraft={onRemoveDraft}
								onPostDraft={onPostDraft}
							/>
						)}
					</>
				)}
			</div>
			<PanelFoot
				draftCount={draftsForFile.length}
				provenance={provenance}
				sendState={sendState}
				onSendRound={onSendRound}
			/>
		</aside>
	)
}

function PanelHeader({
	filter,
	onFilterChange,
	open,
	resolved,
	total,
	roundFilter,
	onClearRoundFilter,
}: {
	filter: ReviewFilter
	onFilterChange: (next: ReviewFilter) => void
	open: number
	resolved: number
	total: number
	roundFilter: string | null
	onClearRoundFilter: () => void
}) {
	const counts: Record<ReviewFilter, number> = { open, resolved, all: total }
	return (
		<div className="flex flex-col gap-2 border-b p-3">
			<div className="flex items-center gap-1" role="tablist" aria-label="Review filter">
				{(Object.keys(FILTER_LABELS) as ReviewFilter[]).map((key) => (
					<button
						type="button"
						role="tab"
						aria-selected={filter === key}
						key={key}
						onClick={() => onFilterChange(key)}
						className={cn(
							'flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
							filter === key
								? 'bg-primary text-primary-foreground'
								: 'text-muted-foreground hover:bg-muted',
						)}
					>
						{FILTER_LABELS[key]} <span className="tabular-nums opacity-70">{counts[key]}</span>
					</button>
				))}
			</div>
			{roundFilter && (
				<div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-xs">
					<span className="text-muted-foreground">Round filter active</span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="ml-auto h-6 px-2 text-xs"
						onClick={onClearRoundFilter}
					>
						Clear
					</Button>
				</div>
			)}
		</div>
	)
}

interface PageGroupData {
	key: string
	pageLabel: string
	comments: FileCommentDto[]
}

function groupByPage(comments: FileCommentDto[]): PageGroupData[] {
	const byPage = new Map<string, FileCommentDto[]>()
	for (const c of comments) {
		const key = c.page === null ? '__nopage' : String(c.page)
		const arr = byPage.get(key)
		if (arr) arr.push(c)
		else byPage.set(key, [c])
	}
	const groups: PageGroupData[] = []
	// Numeric pages first, ascending, then the no-page bucket.
	for (const [key, list] of byPage.entries()) {
		if (key === '__nopage') continue
		groups.push({
			key,
			pageLabel: `Page ${Number(key) + 1}`,
			comments: list,
		})
	}
	groups.sort((a, b) => Number(a.key) - Number(b.key))
	if (byPage.has('__nopage')) {
		groups.push({
			key: '__nopage',
			pageLabel: 'No page',
			// biome-ignore lint/style/noNonNullAssertion: guarded by the has() check
			comments: byPage.get('__nopage')!,
		})
	}
	return groups
}

function PageGroup({
	group,
	actorsById,
	onResolve,
	onReopen,
}: {
	group: PageGroupData
	actorsById: Map<string, ActorListItem>
	onResolve: (c: FileCommentDto) => void
	onReopen: (c: FileCommentDto) => void
}) {
	// Thread rendering: any comment with `parentId === null` is a root; its
	// replies are children (recursively). We flatten only one level here — the
	// panel-only threading in the spec allows nested threads but the UI in
	// this slice is a single reply depth, matching the mockups.
	const roots = group.comments.filter((c) => c.parentId === null)
	const repliesByParent = new Map<string, FileCommentDto[]>()
	for (const c of group.comments) {
		if (!c.parentId) continue
		const arr = repliesByParent.get(c.parentId)
		if (arr) arr.push(c)
		else repliesByParent.set(c.parentId, [c])
	}
	return (
		<div className="border-b last:border-b-0">
			<div className="sticky top-0 z-10 flex items-center justify-between border-b bg-card px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
				<span>{group.pageLabel}</span>
				<span className="tabular-nums">{group.comments.length}</span>
			</div>
			<ul className="flex flex-col gap-0">
				{roots.map((root) => (
					<li key={root.id} className="border-b last:border-b-0">
						<CommentCard
							comment={root}
							actorsById={actorsById}
							onResolve={onResolve}
							onReopen={onReopen}
						/>
						{(repliesByParent.get(root.id) ?? []).map((reply) => (
							<div key={reply.id} className="pl-8">
								<CommentCard
									comment={reply}
									actorsById={actorsById}
									isReply
									onResolve={onResolve}
									onReopen={onReopen}
								/>
							</div>
						))}
					</li>
				))}
			</ul>
		</div>
	)
}

function CommentCard({
	comment,
	actorsById,
	isReply,
	onResolve,
	onReopen,
}: {
	comment: FileCommentDto
	actorsById: Map<string, ActorListItem>
	isReply?: boolean
	onResolve: (c: FileCommentDto) => void
	onReopen: (c: FileCommentDto) => void
}) {
	const author = actorsById.get(comment.authorId)
	const resolvedActor = comment.resolvedBy ? actorsById.get(comment.resolvedBy) : null
	const isResolved = Boolean(comment.resolvedAt)

	return (
		<article
			data-comment-card
			data-comment-id={comment.id}
			data-resolved={isResolved || undefined}
			data-reply={isReply || undefined}
			className={cn(
				'group flex flex-col gap-1.5 px-3 py-2 text-xs',
				isResolved && 'text-muted-foreground',
			)}
		>
			<header className="flex items-center gap-2">
				<ActorAvatar
					id={author?.id}
					name={author?.name ?? 'Unknown'}
					type={author?.type ?? 'human'}
					size="sm"
				/>
				<span className="font-medium text-foreground">{author?.name ?? 'Unknown'}</span>
				<RelativeTime
					date={comment.createdAt}
					className="text-[11px] text-muted-foreground"
					compact
				/>
				{comment.roundId ? (
					<span
						className="ml-auto rounded-sm bg-secondary px-1.5 py-0.5 text-[9px] font-medium uppercase text-secondary-foreground"
						data-testid="comment-sent-badge"
						title={`Sent to ${resolvedActor?.name ?? 'driver'}`}
					>
						Sent
					</span>
				) : null}
			</header>
			<p className="whitespace-pre-wrap text-foreground/90">{comment.body}</p>
			<footer className="flex items-center gap-2">
				{isResolved ? (
					<>
						<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
							Resolved {resolvedActor?.name ? `· ${resolvedActor.name}` : ''}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="ml-auto h-6 px-2 text-[11px]"
							onClick={() => onReopen(comment)}
						>
							Reopen
						</Button>
					</>
				) : (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="ml-auto h-6 px-2 text-[11px]"
						onClick={() => onResolve(comment)}
					>
						<Check size={12} /> Resolve
					</Button>
				)}
			</footer>
		</article>
	)
}

function DraftGroup({
	drafts,
	onUpdateDraftBody,
	onRemoveDraft,
	onPostDraft,
}: {
	drafts: FileCommentDraft[]
	onUpdateDraftBody: (tempId: string, body: string) => void
	onRemoveDraft: (tempId: string) => void
	onPostDraft: (draft: FileCommentDraft) => void
}) {
	return (
		<div className="border-b bg-warning/5 last:border-b-0">
			<div className="sticky top-0 z-10 flex items-center justify-between border-b bg-warning/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
				<span>Drafts</span>
				<span className="tabular-nums">{drafts.length}</span>
			</div>
			<ul className="flex flex-col gap-0">
				{drafts.map((draft) => (
					<li key={draft.tempId} className="border-b last:border-b-0 px-3 py-2">
						<DraftCard
							draft={draft}
							onUpdateDraftBody={onUpdateDraftBody}
							onRemoveDraft={onRemoveDraft}
							onPostDraft={onPostDraft}
						/>
					</li>
				))}
			</ul>
		</div>
	)
}

function DraftCard({
	draft,
	onUpdateDraftBody,
	onRemoveDraft,
	onPostDraft,
}: {
	draft: FileCommentDraft
	onUpdateDraftBody: (tempId: string, body: string) => void
	onRemoveDraft: (tempId: string) => void
	onPostDraft: (draft: FileCommentDraft) => void
}) {
	const [localBody, setLocalBody] = useState(draft.body)
	return (
		<article data-comment-draft className="flex flex-col gap-2">
			<header className="flex items-center gap-2 text-[11px] text-muted-foreground">
				<span className="rounded-sm bg-warning/20 px-1.5 py-0.5 text-[9px] font-medium uppercase text-warning">
					Draft
				</span>
				<span>
					{draft.page !== null ? `Page ${draft.page + 1}` : 'Unpaged'} · pin (
					{Math.round(draft.positionDoc.x * 100)}%, {Math.round(draft.positionDoc.y * 100)}%)
				</span>
			</header>
			<Textarea
				value={localBody}
				onChange={(e) => {
					setLocalBody(e.target.value)
					onUpdateDraftBody(draft.tempId, e.target.value)
				}}
				placeholder="What should the driver see?"
				className="min-h-[80px] text-xs"
			/>
			<div className="flex items-center gap-1">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-7 px-2 text-xs"
					onClick={() => onRemoveDraft(draft.tempId)}
				>
					Discard
				</Button>
				<Button
					type="button"
					variant="secondary"
					size="sm"
					className="ml-auto h-7 px-2 text-xs"
					disabled={localBody.trim().length === 0}
					onClick={() => onPostDraft({ ...draft, body: localBody })}
				>
					Save draft
				</Button>
			</div>
		</article>
	)
}

function PanelFoot({
	draftCount,
	provenance,
	sendState,
	onSendRound,
}: {
	draftCount: number
	provenance: ProvenanceResolution
	sendState: ReviewPanelProps['sendState']
	onSendRound: (targetObjectId: string) => void
}) {
	// The Send button's enabled/disabled rule follows the spec's provenance
	// contract: 'enabled' fires immediately; 'picker-required' means the many-
	// variant user hasn't picked a target yet; 'disabled' covers 0-attach,
	// archived and orphaned.
	const target = provenance.defaultTarget
	const disabledReason = deriveDisabledReason(provenance, target, draftCount)
	const isSending = sendState.phase === 'sending'
	const isSent = sendState.phase === 'sent'

	if (isSent) {
		return (
			<div className="flex flex-col gap-1 border-t p-3 text-xs" data-testid="panel-foot-sent">
				<div className="flex items-center gap-2 font-medium text-foreground">
					<span>Sent · {sendState.lockedDriverName ?? 'driver'}</span>
					{sendState.lockedDriverType === 'agent' && (
						<span className="ml-auto rounded-sm bg-secondary px-1.5 py-0.5 text-[9px] font-medium uppercase text-secondary-foreground">
							🔒 Awaiting agent response
						</span>
					)}
				</div>
				<p className="text-[11px] text-muted-foreground">
					Round locked for this session. Start a new draft to open a fresh round.
				</p>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-2 border-t p-3">
			<div className="text-[11px] text-muted-foreground" data-testid="panel-foot-status">
				{draftCount === 0
					? 'Add drafts on the stage, then send the round.'
					: `${draftCount} draft${draftCount === 1 ? '' : 's'} ready to send.`}
			</div>
			<Button
				type="button"
				size="sm"
				className="h-8 text-xs"
				disabled={disabledReason !== null || draftCount === 0 || !target || isSending}
				onClick={() => target && onSendRound(target.id)}
				title={disabledReason ?? undefined}
				data-testid="panel-send-round"
			>
				{isSending ? 'Sending…' : `Send round${target ? ` · ${target.title}` : ''}`}
			</Button>
		</div>
	)
}

function deriveDisabledReason(
	provenance: ProvenanceResolution,
	target: AttachingObject | null,
	draftCount: number,
): string | null {
	if (provenance.variant === 'zero') return "This file isn't attached to any object"
	if (provenance.variant === 'archived') return 'The attached object is archived'
	if (provenance.variant === 'orphaned') return 'The attached object was archived mid-review'
	if (provenance.send === 'picker-required') return 'Pick a target object first'
	if (draftCount === 0) return 'No drafts to send'
	if (!target) return 'No target object'
	return null
}

// Convenience for the route: gets a display name from the actors cache without
// forcing every caller to import both the hook and the map builder.
export function useCurrentActorName(): string | null {
	const actor = getStoredActor()
	return actor?.name ?? null
}
