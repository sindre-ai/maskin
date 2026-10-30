import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
	useAcceptAll,
	useAcceptChange,
	useFileProposals,
	useRefreshFileReview,
	useRejectAll,
	useRejectChange,
} from '@/hooks/use-file-proposals'
import { trackChangeReviewOpened } from '@/lib/analytics'
import { ApiError, type FileDetail, type FileProposalDto } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { ChangeAppliedContext } from '@/lib/change-applied-context'
import { type ReviewItem, buildReviewItems, wordDiff } from '@/lib/change-review'
import { cn } from '@/lib/cn'
import { X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

type ChangeDto = FileProposalDto['changes'][number]

const FADE_MS = 180

/** Changes the review shows: every one still pending. A stale one gets a card that can only be rejected. */
function reviewable(proposal: FileProposalDto): ChangeDto[] {
	return proposal.changes.filter((c) => c.status === 'pending')
}

const BUTTON_TOUCH = 'max-sm:h-10'

function DiffText({ before, after }: { before: string; after: string }) {
	const parts = useMemo(() => wordDiff(before, after), [before, after])
	return (
		<p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
			{parts.map((part, i) => {
				const key = `${part.type}-${i}`
				if (part.type === 'del')
					return (
						<del key={key} className="bg-status-failed-bg text-status-failed-text line-through">
							<span className="sr-only">removed: </span>
							{part.text}
						</del>
					)
				if (part.type === 'ins')
					return (
						<ins key={key} className="bg-status-done-bg text-status-done-text underline">
							<span className="sr-only">added: </span>
							{part.text}
						</ins>
					)
				return <span key={key}>{part.text}</span>
			})}
		</p>
	)
}

interface ChangeCardProps {
	change: ChangeDto
	number: number
	leaving: boolean
	applying: boolean
	/** Another action (Accept all, Reject all) is in flight. */
	locked: boolean
	/** The text this change applies to was edited since: it can only be rejected. */
	stale: boolean
	/** The last Accept failed. */
	failed: boolean
	onAccept: (appliedText: string | undefined) => void
	onReject: () => void
	registerAccept: (el: HTMLButtonElement | null) => void
	registerReject: (el: HTMLButtonElement | null) => void
}

function ChangeCard({
	change,
	number,
	leaving,
	applying,
	locked,
	stale,
	failed,
	onAccept,
	onReject,
	registerAccept,
	registerReject,
}: ChangeCardProps) {
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(change.newText)
	const edited = draft !== change.newText
	const finalText = edited ? draft : change.newText
	const busy = applying || leaving || locked

	return (
		<section
			aria-label={`Change ${number}`}
			className={cn(
				'rounded-xl border border-brand/30 bg-card p-4 shadow-xs transition-opacity duration-180',
				leaving && 'opacity-0',
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="text-sm font-semibold text-foreground">Change {number}</h3>
					{change.reason && <p className="mt-0.5 text-xs text-muted-foreground">{change.reason}</p>}
				</div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={busy || stale}
					className={BUTTON_TOUCH}
					onClick={() => setEditing((v) => !v)}
				>
					{editing ? 'Done' : 'Edit'}
				</Button>
			</div>

			<div className="mt-3">
				{editing ? (
					<Textarea
						autoResize
						aria-label={`Edit change ${number}`}
						value={draft}
						disabled={busy}
						className="min-h-20 text-sm"
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key !== 'Escape') return
							// Esc is Done here; elsewhere in the review it leaves the review.
							e.stopPropagation()
							setEditing(false)
						}}
					/>
				) : stale ? (
					<p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
						{change.newText}
					</p>
				) : (
					<DiffText before={change.oldText} after={finalText} />
				)}
			</div>

			{failed && !stale && (
				<p
					role="alert"
					className="mt-3 rounded-md bg-status-failed-bg px-3 py-2 text-sm text-status-failed-text"
				>
					Couldn't apply this change. Try again.
				</p>
			)}

			<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
				{stale ? (
					<p role="alert" className="text-xs text-warning max-sm:w-full">
						The text this change applies to has been edited since.
					</p>
				) : (
					<p className="text-xs text-muted-foreground max-sm:w-full">
						{edited
							? 'Your edit will be applied.'
							: 'Click Edit to adjust the text before accepting.'}
					</p>
				)}
				<div className="flex items-center gap-2">
					<Button
						ref={registerReject}
						type="button"
						variant="outline"
						size="sm"
						disabled={busy}
						className={BUTTON_TOUCH}
						onClick={onReject}
					>
						Reject
					</Button>
					<Button
						ref={registerAccept}
						type="button"
						size="sm"
						disabled={stale ? undefined : busy}
						aria-disabled={stale || undefined}
						className={cn(BUTTON_TOUCH, stale && 'cursor-not-allowed opacity-50')}
						onClick={() => {
							// A stale Accept stays in the tab order so the reason is reachable, but does nothing.
							if (!stale) onAccept(edited ? draft : undefined)
						}}
					>
						{applying ? 'Applying…' : stale ? "Can't apply" : failed ? 'Retry' : 'Accept'}
					</Button>
				</div>
			</div>
		</section>
	)
}

function BannerSkeleton() {
	return (
		<output
			aria-label="Loading proposed changes"
			className="flex items-center gap-3 rounded-xl border border-border bg-surface-sunken px-4 py-3"
		>
			<Skeleton className="h-5 w-5 rounded-full" />
			<Skeleton className="h-4 w-64 max-w-full" />
		</output>
	)
}

interface ChangeReviewViewProps {
	file: FileDetail
	fileText: string
	proposal: FileProposalDto
	/** Moves focus back to the document when the review ends. */
	onClose: () => void
	/** A change was written to the file. */
	onApplied: () => void
}

function ActionBar({
	count,
	agent,
	busy,
	accepting,
	onAcceptAll,
	onRejectAll,
	onClose,
}: {
	count: number
	agent: string
	busy: boolean
	accepting: boolean
	onAcceptAll: () => void
	onRejectAll: () => void
	onClose: () => void
}) {
	return (
		<section
			aria-label="Review actions"
			className="sticky bottom-5 z-10 mx-auto flex w-full max-w-full flex-wrap items-center justify-between gap-3 rounded-xl bg-primary px-4 py-3 text-primary-foreground shadow-lg ease-brand motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200 md:w-fit"
		>
			<p className="text-sm font-medium">
				{count} {count === 1 ? 'change' : 'changes'} from {agent}
			</p>
			<div className="flex items-center gap-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={busy}
					className={cn(
						'text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground',
						BUTTON_TOUCH,
					)}
					onClick={onRejectAll}
				>
					Reject all
				</Button>
				<Button
					type="button"
					variant="secondary"
					size="sm"
					disabled={busy}
					className={BUTTON_TOUCH}
					onClick={onAcceptAll}
				>
					{accepting ? 'Applying…' : 'Accept all'}
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					aria-label="Leave review without deciding"
					className="size-9 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground max-sm:size-10"
					onClick={onClose}
				>
					<X size={16} aria-hidden="true" />
				</Button>
			</div>
		</section>
	)
}

/**
 * The review view that stands where the editor was: neighbouring blocks as muted
 * context, a gap row for every run of untouched blocks, one card per change.
 */
export function ChangeReviewView({
	file,
	fileText,
	proposal,
	onClose,
	onApplied,
}: ChangeReviewViewProps) {
	const accept = useAcceptChange(file.workspaceId, file.id)
	const reject = useRejectChange(file.workspaceId, file.id)
	const acceptAll = useAcceptAll(file.workspaceId, file.id)
	const rejectAll = useRejectAll(file.workspaceId, file.id)
	const refresh = useRefreshFileReview(file.workspaceId, file.id)
	const [decided, setDecided] = useState<ReadonlySet<string>>(new Set())
	const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
	const [applying, setApplying] = useState<ReadonlySet<string>>(new Set())
	// Changes the server refused as stale after the file was last read, and changes whose Accept failed.
	const [refusedStale, setRefusedStale] = useState<ReadonlySet<string>>(new Set())
	const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
	const [bulk, setBulk] = useState<'accept' | 'reject' | null>(null)
	const [focusReject, setFocusReject] = useState<string | null>(null)
	const acceptButtons = useRef(new Map<string, HTMLButtonElement>())
	const rejectButtons = useRef(new Map<string, HTMLButtonElement>())

	const changes = useMemo(
		() => reviewable(proposal).filter((c) => !decided.has(c.id)),
		[proposal, decided],
	)
	const byId = useMemo(() => new Map(changes.map((c) => [c.id, c])), [changes])
	const items: ReviewItem[] = useMemo(
		() => buildReviewItems(fileText, changes),
		[fileText, changes],
	)
	const order = useMemo(
		() => items.flatMap((i) => (i.kind === 'change' ? [i.changeId] : [])),
		[items],
	)

	useEffect(() => {
		if (order.length === 0) onClose()
	}, [order.length, onClose])

	const isStale = useCallback(
		(change: ChangeDto) => change.stale || refusedStale.has(change.id),
		[refusedStale],
	)

	const finish = useCallback(
		(changeIds: string[]) => {
			const only = changeIds.length === 1 ? changeIds[0] : undefined
			const next = only ? (order[order.indexOf(only) + 1] ?? null) : null
			setLeaving((s) => new Set([...s, ...changeIds]))
			// The refetch waits for the fade to end: an accepted change drops out of the open
			// proposals and out of the new file text, and the card must not vanish mid-fade.
			window.setTimeout(() => {
				refresh().finally(() => {
					setDecided((s) => new Set([...s, ...changeIds]))
					setLeaving((s) => new Set([...s].filter((id) => !changeIds.includes(id))))
					const target = next ? acceptButtons.current.get(next) : undefined
					if (target) target.focus()
				})
			}, FADE_MS)
		},
		[order, refresh],
	)

	const decide = useCallback(
		async (changeId: string, appliedText?: string, rejecting = false) => {
			setApplying((s) => new Set(s).add(changeId))
			setFailed((s) => {
				const n = new Set(s)
				n.delete(changeId)
				return n
			})
			try {
				if (rejecting) await reject.mutateAsync({ proposalId: proposal.id, changeId })
				else {
					await accept.mutateAsync({ proposalId: proposal.id, changeId, appliedText })
					onApplied()
				}
				finish([changeId])
			} catch (err) {
				// A rejection already toasted. A failed accept shows on its card.
				if (rejecting) return
				if (err instanceof ApiError && err.status === 409 && err.staleChangeIds?.includes(changeId))
					setRefusedStale((s) => new Set(s).add(changeId))
				else setFailed((s) => new Set(s).add(changeId))
			} finally {
				setApplying((s) => {
					const n = new Set(s)
					n.delete(changeId)
					return n
				})
			}
		},
		[accept, reject, finish, onApplied, proposal.id],
	)

	const decideAll = useCallback(
		async (kind: 'accept' | 'reject') => {
			const changeIds = changes.map((c) => c.id)
			setBulk(kind)
			try {
				if (kind === 'accept') {
					await acceptAll.mutateAsync({ proposalId: proposal.id, changeIds })
					onApplied()
				} else await rejectAll.mutateAsync({ proposalId: proposal.id, changeIds })
				finish(changeIds)
			} catch (err) {
				if (kind === 'reject') return
				const staleIds =
					err instanceof ApiError && err.status === 409 ? (err.staleChangeIds ?? []) : []
				if (staleIds.length > 0) {
					// The server applied nothing. Mark the stale cards, leave the rest pending, and
					// move focus to the first stale card's Reject.
					setRefusedStale((s) => new Set([...s, ...staleIds]))
					setFocusReject(order.find((id) => staleIds.includes(id)) ?? null)
				} else {
					toast.error("Couldn't apply these changes. Try again.")
					void refresh()
				}
			} finally {
				setBulk(null)
			}
		},
		[changes, acceptAll, rejectAll, proposal.id, onApplied, finish, order, refresh],
	)

	useEffect(() => {
		if (!focusReject || bulk) return
		rejectButtons.current.get(focusReject)?.focus()
		setFocusReject(null)
	}, [focusReject, bulk])

	return (
		<div
			className="space-y-3"
			onKeyDown={(e) => {
				if (e.key === 'Escape') onClose()
			}}
		>
			{items.map((item) => {
				if (item.kind === 'context')
					return (
						<p key={item.key} className="px-1 text-sm leading-relaxed text-muted-foreground">
							{item.text}
						</p>
					)
				if (item.kind === 'gap')
					return (
						<p key={item.key} className="px-1 text-xs text-muted-foreground">
							{item.count} unchanged {item.count === 1 ? 'block' : 'blocks'}
						</p>
					)
				const change = byId.get(item.changeId)
				if (!change) return null
				return (
					<ChangeCard
						key={item.key}
						change={change}
						number={item.number}
						leaving={leaving.has(change.id)}
						applying={applying.has(change.id)}
						locked={bulk !== null}
						stale={isStale(change)}
						failed={failed.has(change.id)}
						onAccept={(text) => decide(change.id, text)}
						onReject={() => decide(change.id, undefined, true)}
						registerAccept={(el) => {
							if (el) acceptButtons.current.set(change.id, el)
							else acceptButtons.current.delete(change.id)
						}}
						registerReject={(el) => {
							if (el) rejectButtons.current.set(change.id, el)
							else rejectButtons.current.delete(change.id)
						}}
					/>
				)
			})}
			{changes.length > 0 && (
				<ActionBar
					count={changes.length}
					agent={proposal.author.name}
					busy={bulk !== null}
					accepting={bulk === 'accept'}
					onAcceptAll={() => decideAll('accept')}
					onRejectAll={() => decideAll('reject')}
					onClose={onClose}
				/>
			)}
		</div>
	)
}

function ProposalBanner({
	proposal,
	count,
	reviewing,
	onToggle,
}: {
	proposal: FileProposalDto
	count: number
	reviewing: boolean
	onToggle: () => void
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-sunken px-4 py-3">
			<div className="flex min-w-0 items-center gap-3">
				<ActorAvatar
					name={proposal.author.name}
					type={proposal.author.type}
					id={proposal.author.id}
				/>
				<p className="text-sm text-foreground">
					{proposal.author.name} proposed {count} {count === 1 ? 'change' : 'changes'} to this text.
				</p>
			</div>
			<Button type="button" size="sm" aria-pressed={reviewing} onClick={onToggle}>
				Review changes
			</Button>
		</div>
	)
}

interface ChangeReviewLayerProps {
	file: FileDetail
	fileText: string
	/** The document editor, shown whenever the review is not open. */
	children: ReactNode
}

/**
 * Banner above the document and, once opened, the review view in place of the
 * editor. Mounted behind the agent-change-review flag; with the flag off the
 * file viewer renders the editor alone.
 */
export function ChangeReviewLayer({ file, fileText, children }: ChangeReviewLayerProps) {
	const { data: proposals, isLoading } = useFileProposals(file.workspaceId, file.id, true)
	const [reviewingId, setReviewingId] = useState<string | null>(null)
	const [applied, setApplied] = useState(false)
	const appliedState = useMemo(() => ({ applied, clear: () => setApplied(false) }), [applied])
	const documentRef = useRef<HTMLDivElement>(null)

	const open = useMemo(
		() =>
			(proposals ?? [])
				.map((proposal) => ({ proposal, count: reviewable(proposal).length }))
				.filter((p) => p.count > 0),
		[proposals],
	)
	const reviewing = open.find((p) => p.proposal.id === reviewingId)?.proposal ?? null

	const leave = useCallback(() => {
		setReviewingId(null)
		documentRef.current?.focus()
	}, [])

	// The last open change was decided and the refetch took the proposal away: the
	// review ends and focus returns to the document.
	useEffect(() => {
		if (reviewingId && !reviewing && !isLoading) leave()
	}, [reviewingId, reviewing, isLoading, leave])

	const toggle = (proposal: FileProposalDto) => {
		if (reviewingId === proposal.id) return leave()
		setReviewingId(proposal.id)
		trackChangeReviewOpened({
			workspace_id: file.workspaceId,
			actor_id: getStoredActor()?.id ?? null,
			file_name: file.name,
			proposal_id: proposal.id,
		})
	}

	return (
		<div className="space-y-4">
			{isLoading && <BannerSkeleton />}
			{open.map(({ proposal, count }) => (
				<ProposalBanner
					key={proposal.id}
					proposal={proposal}
					count={count}
					reviewing={reviewingId === proposal.id}
					onToggle={() => toggle(proposal)}
				/>
			))}
			<div ref={documentRef} tabIndex={-1} className="outline-none">
				{reviewing ? (
					<ChangeReviewView
						file={file}
						fileText={fileText}
						proposal={reviewing}
						onClose={leave}
						onApplied={() => setApplied(true)}
					/>
				) : (
					<ChangeAppliedContext.Provider value={appliedState}>
						{children}
					</ChangeAppliedContext.Provider>
				)}
			</div>
		</div>
	)
}
