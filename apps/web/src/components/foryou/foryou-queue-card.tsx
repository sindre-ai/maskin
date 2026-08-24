import { ActivityComment } from '@/components/activity/activity-comment'
import { CommentInput } from '@/components/activity/comment-input'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import { useActor } from '@/hooks/use-actors'
import { useEntityThread } from '@/hooks/use-entity-thread'
import { useCreateComment } from '@/hooks/use-events'
import { useMarkRead, useMarkUnread } from '@/hooks/use-subscriptions'
import { useSwipeToMarkRead } from '@/hooks/use-swipe-to-mark-read'
import { trackForyouCardAction, trackForyouCardShown } from '@/lib/analytics'
import type { EventResponse, UnreadItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
	CARD_ACTIONS,
	type CardAction,
	type CardKind,
	QUICK_REPLY_CHIPS,
	afterDecisionChips,
	classifyCardKind,
} from '@/lib/foryou-card-kind'
import { Link } from '@tanstack/react-router'
import { ArrowUp, CheckIcon, CornerDownLeft, X } from 'lucide-react'
import {
	type TransitionEvent,
	type UIEvent,
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from 'react'
import { toast } from 'sonner'

// Honest, short reversible window for a decision commit — long enough to read
// the receipt and change your mind. Not the mockup's fabricated "Reversible
// for 2h" — a real durable multi-hour window needs a backend pending-decision
// table this canary doesn't have.
const DECISION_REVERSE_WINDOW_MS = 6000

// Mockup's `cuScroll` (line 338): the earlier-history hint arms once the reader
// has scrolled the thread down a little, then fires when they scroll back to
// the very top — "pull to load more" without the pull.
const SCROLL_ARM_PX = 40
const SCROLL_FIRE_PX = 8

export function itemQueueKey(item: UnreadItem): string {
	return `${item.entity_type}:${item.entity_id}`
}

export interface ForYouQueueCardHandle {
	// Triggers the same toast/timer/deferred-mark-read path a completed
	// right-swipe does — for the orchestrator's fixed "Mark as read" button.
	commit: () => void
	// Mutation-free exit — the orchestrator's "Keep unread" button.
	skip: () => void
}

interface ForYouQueueCardProps {
	workspaceId: string
	item: UnreadItem
	// The item is done with (mark-read committed, or skipped) — advance the queue.
	onProcessed: (key: string) => void
	// The mark-read commit's Undo was clicked — restore this item as current.
	onRestored: (key: string) => void
	// A mark-read/mark-unread commit was scheduled (swipe or button) — the
	// orchestrator keeps this card mounted (hidden, once it's no longer
	// current) until onCommitSettled fires, so advancing the queue can't
	// unmount the card mid-flight and cancel its own deferred mutation.
	onCommitScheduled: (key: string) => void
	// The deferred mutation actually landed — safe to fully discard this card now.
	onCommitSettled: (key: string) => void
}

type DecisionPhase =
	| { status: 'idle' }
	| { status: 'receipt'; action: CardAction; deadline: number }
	// The reverse window elapsed AND the threaded reply really posted — the
	// receipt's reason rows render from this real commit, not static JSX.
	| { status: 'committed'; action: CardAction }

export const ForYouQueueCard = forwardRef<ForYouQueueCardHandle, ForYouQueueCardProps>(
	function ForYouQueueCard(
		{ workspaceId, item, onProcessed, onRestored, onCommitScheduled, onCommitSettled },
		ref,
	) {
		const objectId = item.entity_id
		const itemKey = itemQueueKey(item)

		const {
			containerRef: threadRef,
			nodes,
			firstUnreadRootId,
			firstUnreadEventId,
			latestRootId,
			latestEventId,
		} = useEntityThread(workspaceId, objectId, item.unread_count)

		const cardKind: CardKind = classifyCardKind(item)

		const impressionFiredRef = useRef(false)
		useEffect(() => {
			if (impressionFiredRef.current) return
			impressionFiredRef.current = true
			trackForyouCardShown({ card_kind: cardKind, card_id: objectId })
		}, [cardKind, objectId])

		const emitAction = useCallback(
			(actionId: string) => {
				trackForyouCardAction({ card_kind: cardKind, card_id: objectId, action_id: actionId })
			},
			[cardKind, objectId],
		)

		const markRead = useMarkRead(workspaceId)
		const handleMarkRead = useCallback(() => {
			const target = Math.max(item.latest_event_id ?? 0, latestEventId)
			if (target <= 0) return
			markRead.mutate({ entityType: item.entity_type, entityId: objectId, lastEventId: target })
		}, [markRead, item.entity_type, objectId, item.latest_event_id, latestEventId])

		// Not used as a swipe gesture here (queue cards are always unread) —
		// wired into the hook purely so Undo has a real reverse mutation to
		// call after a mark-read commit has already landed.
		const markUnread = useMarkUnread(workspaceId)
		const handleMarkUnread = useCallback(() => {
			markUnread.mutate({ entityType: item.entity_type, entityId: objectId })
		}, [markUnread, item.entity_type, objectId])

		const replyTarget = firstUnreadRootId ?? latestRootId ?? undefined
		// A message the reader explicitly aimed at with the row's reply control.
		// It overrides the default thread target for the card's one composer and
		// its chips, and puts the "Replying to <name>" banner above them
		// (mockup 446–448).
		const [replyTo, setReplyTo] = useState<{ eventId: number; name: string } | null>(null)
		const activeReplyTarget = replyTo?.eventId ?? replyTarget
		const handleReplyTo = useCallback((event: EventResponse, authorName: string) => {
			setReplyTo({ eventId: event.id, name: authorName })
		}, [])
		const quickReply = useCreateComment(workspaceId, objectId)

		// Exit-fling animation, shared by drag-commit, button-commit, and skip —
		// all three funnel through here so there's exactly one exit path. The
		// queue only advances once the fling transition actually finishes.
		const [exitDir, setExitDir] = useState<'left' | 'right' | null>(null)
		const beginExit = useCallback((dir: 'left' | 'right') => setExitDir(dir), [])
		const handleExitTransitionEnd = useCallback(
			(e: TransitionEvent<HTMLDivElement>) => {
				if (e.target !== e.currentTarget || e.propertyName !== 'transform') return
				if (!exitDir) return
				onProcessed(itemKey)
			},
			[exitDir, onProcessed, itemKey],
		)

		// "Keep unread" is a pure skip — no mutation, no undo, distinct from the
		// hook's mark-unread variant (which reverses a previously *read* item;
		// queue cards are always unread). Wired to both the fixed action bar and
		// left-swipe (via onSwipeLeft below).
		const handleSkip = useCallback(() => {
			emitAction('keep_unread')
			beginExit('left')
		}, [emitAction, beginExit])

		const {
			dragOffset,
			isDragging,
			swipeBgOpacity,
			handlePointerDown,
			handlePointerMove,
			handlePointerUp,
			handlePointerCancel,
			commit,
		} = useSwipeToMarkRead({
			onMarkRead: handleMarkRead,
			onMarkUnread: handleMarkUnread,
			analytics: { entity_type: item.entity_type, entity_id: objectId },
			onCommitScheduled: () => {
				beginExit('right')
				onCommitScheduled(itemKey)
			},
			onUndo: () => {
				setExitDir(null)
				onRestored(itemKey)
			},
			onCommitSettled: () => onCommitSettled(itemKey),
			onSwipeLeft: handleSkip,
		})

		// Decision → decided-receipt is fully independent of the swipe hook: its
		// own phase state, own timer, own "Reverse this" undo. Defer-then-commit
		// because no delete-comment mutation exists — the comment is only posted
		// once the reverse window elapses.
		const [decisionPhase, setDecisionPhase] = useState<DecisionPhase>({ status: 'idle' })
		const decisionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
		useEffect(
			() => () => {
				if (decisionTimer.current) clearTimeout(decisionTimer.current)
			},
			[],
		)

		const chooseDecision = useCallback(
			(action: CardAction) => {
				emitAction(action.id)
				setDecisionPhase({
					status: 'receipt',
					action,
					deadline: Date.now() + DECISION_REVERSE_WINDOW_MS,
				})
				decisionTimer.current = setTimeout(() => {
					quickReply.mutate(
						{ entity_id: objectId, content: action.label, parent_event_id: activeReplyTarget },
						{
							onSuccess: () => {
								setDecisionPhase({ status: 'committed', action })
								handleMarkRead()
								beginExit('right')
							},
						},
					)
				}, DECISION_REVERSE_WINDOW_MS)
			},
			[emitAction, quickReply, objectId, activeReplyTarget, handleMarkRead, beginExit],
		)

		const reverseDecision = useCallback(() => {
			if (decisionTimer.current) {
				clearTimeout(decisionTimer.current)
				decisionTimer.current = null
			}
			setDecisionPhase({ status: 'idle' })
		}, [])

		// Live countdown for the receipt's "Reversible for Ns" label.
		const [now, setNow] = useState(() => Date.now())
		useEffect(() => {
			if (decisionPhase.status !== 'receipt') return
			const interval = setInterval(() => setNow(Date.now()), 250)
			return () => clearInterval(interval)
		}, [decisionPhase.status])
		const secondsLeft =
			decisionPhase.status === 'receipt'
				? Math.max(0, Math.ceil((decisionPhase.deadline - now) / 1000))
				: 0

		const runQuickReply = useCallback(
			(action: CardAction) => {
				emitAction(action.id)
				quickReply.mutate(
					{ entity_id: objectId, content: action.label, parent_event_id: activeReplyTarget },
					{
						onSuccess: () => {
							handleMarkRead()
							setReplyTo(null)
							toast(`✓ ${action.label}`)
						},
					},
				)
			},
			[quickReply, objectId, activeReplyTarget, handleMarkRead, emitAction],
		)

		useImperativeHandle(ref, () => ({ commit: () => commit('mark-read'), skip: handleSkip }), [
			commit,
			handleSkip,
		])

		// Everything older than the unread boundary starts collapsed — the card's
		// job is triaging what's new, not re-reading history. The hint reveals it
		// on demand; there's no re-collapse since the reveal is one-directional.
		const [earlierExpanded, setEarlierExpanded] = useState(false)
		const boundaryIndex =
			firstUnreadRootId !== null
				? nodes.findIndex((node) => node.root.id === firstUnreadRootId)
				: -1
		const earlierNodes = boundaryIndex > 0 ? nodes.slice(0, boundaryIndex) : []
		const visibleNodes = boundaryIndex > 0 ? nodes.slice(boundaryIndex) : nodes
		const earlierCount = earlierNodes.reduce((sum, node) => sum + 1 + node.replies.length, 0)

		// Scrolling the thread back to its top reveals the history, mirroring
		// `cuScroll` — the hint button stays as the explicit, testable control.
		const scrollArmedRef = useRef(false)
		const handleThreadScroll = useCallback(
			(event: UIEvent<HTMLDivElement>) => {
				if (earlierExpanded || earlierNodes.length === 0) return
				const top = event.currentTarget.scrollTop
				if (top > SCROLL_ARM_PX) {
					scrollArmedRef.current = true
					return
				}
				if (scrollArmedRef.current && top < SCROLL_FIRE_PX) {
					scrollArmedRef.current = false
					setEarlierExpanded(true)
				}
			},
			[earlierExpanded, earlierNodes.length],
		)

		// Number of unread messages behind the divider — the mockup labels the
		// divider with the count rather than a bare "New".
		const unreadMessageCount = Math.max(item.unread_count, 1)

		// The card header's attribution line names whoever wrote the newest
		// message in the thread. Real data — no fabricated "why" clause.
		const latestNode = nodes.length > 0 ? nodes[nodes.length - 1] : undefined
		const latestReply = latestNode?.replies[latestNode.replies.length - 1]
		const latestAuthorId = latestReply?.actorId ?? latestNode?.root.actorId ?? ''
		const { data: latestAuthor } = useActor(latestAuthorId)

		const title = item.object?.title ?? 'Untitled'
		const objectType = item.object?.type
		const objectStatus = item.object?.status
		const summary = item.object?.content?.trim()
		const decisionActions: readonly CardAction[] | null =
			cardKind === 'decision' ? CARD_ACTIONS.decision : null
		const decisionSettled = decisionPhase.status !== 'idle'
		// Chips are hidden while a decision is still open, and come back once it
		// has been made — minus any chip that just echoes an option (mockup 5962).
		const showChips = !decisionActions || decisionSettled
		const chipActions: readonly CardAction[] = decisionActions
			? afterDecisionChips(decisionActions)
			: cardKind === 'sign_off' || cardKind === 'proposed_bet'
				? CARD_ACTIONS[cardKind]
				: QUICK_REPLY_CHIPS

		const exitTransform =
			exitDir === 'right'
				? 'translateX(140%) rotate(8deg)'
				: exitDir === 'left'
					? 'translateX(-140%) rotate(-8deg)'
					: null
		const dragTransform = `translateX(${dragOffset}px) rotate(${dragOffset / 24}deg)`

		return (
			<div ref={threadRef} className="relative mx-auto h-full w-full max-w-[760px]">
				{/* Drag feedback: a full-card wash plus a pill anchored to the edge
				    the gesture came from (mockup 311–313). */}
				<div
					aria-hidden
					data-testid="mark-read-reveal"
					className="pointer-events-none absolute inset-0 z-[2] rounded-2xl bg-status-active-bg"
					style={{ opacity: isDragging && dragOffset > 0 ? swipeBgOpacity : 0 }}
				/>
				<div
					aria-hidden
					data-testid="keep-unread-reveal"
					className="pointer-events-none absolute inset-0 z-[2] rounded-2xl bg-muted"
					style={{ opacity: isDragging && dragOffset < 0 ? swipeBgOpacity : 0 }}
				/>
				<div
					aria-hidden
					className="pointer-events-none absolute right-4 top-4 z-[4] flex origin-right items-center gap-1.5 rounded-full bg-status-active-text px-3.5 py-2 text-[13px] font-bold text-background shadow-md transition-transform"
					style={{
						opacity: isDragging && dragOffset > 0 ? swipeBgOpacity : 0,
						transform: `scale(${isDragging && dragOffset > 0 ? 1 : 0.7})`,
					}}
				>
					<CheckIcon size={14} />
					Mark as read
				</div>
				<div
					aria-hidden
					className="pointer-events-none absolute left-4 top-4 z-[4] flex origin-left items-center gap-1.5 rounded-full bg-foreground px-3.5 py-2 text-[13px] font-bold text-background shadow-md transition-transform"
					style={{
						opacity: isDragging && dragOffset < 0 ? swipeBgOpacity : 0,
						transform: `scale(${isDragging && dragOffset < 0 ? 1 : 0.7})`,
					}}
				>
					<X size={14} />
					Keep unread
				</div>

				<div
					data-testid="foryou-queue-card"
					data-card-kind={cardKind}
					className={cn(
						'relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-lg cursor-grab touch-pan-y',
						exitDir
							? 'transition-[transform,opacity] duration-slide ease-emphasized'
							: isDragging
								? 'transition-none'
								: 'transition-transform duration-slide ease-emphasized',
					)}
					style={{
						transform: exitTransform ?? dragTransform,
						opacity: exitDir ? 0 : undefined,
					}}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
					onPointerCancel={handlePointerCancel}
					onTransitionEnd={handleExitTransitionEnd}
				>
					{/* Header strip — tinted band, wraps rather than squeezing (mockup 314) */}
					<div className="flex flex-wrap items-center gap-2.5 border-b border-border bg-muted/40 px-3.5 py-2.5">
						{objectType && <TypeBadge type={objectType} variant="tile" />}
						<div className="min-w-[160px] flex-1">
							<Link
								to="/$workspaceId/objects/$objectId"
								params={{ workspaceId, objectId }}
								className="block truncate text-sm font-bold leading-snug text-foreground hover:underline"
								title={title}
							>
								{title}
							</Link>
							<div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
								{latestAuthor && <span className="truncate">{latestAuthor.name}</span>}
								{item.latest_activity_at && (
									<RelativeTime date={item.latest_activity_at} className="font-mono tabular-nums" />
								)}
								{objectStatus && <StatusBadge status={objectStatus} variant="dot-word" />}
							</div>
						</div>
						<Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" asChild>
							<Link to="/$workspaceId/objects/$objectId" params={{ workspaceId, objectId }}>
								Open →
							</Link>
						</Button>
						{/* Mobile has no fixed key hints to lean on — give the thumb a
						    mark-read target inside the card too (mockup 327). */}
						<Button
							size="sm"
							variant="outline"
							className="h-8 shrink-0 text-xs md:hidden"
							onClick={() => commit('mark-read')}
						>
							<CheckIcon size={14} aria-hidden />
							Mark read
						</Button>
					</div>

					{/* Summary band — the object's own body, clamped (mockup 331–336) */}
					{summary && (
						<div
							data-testid="card-summary"
							className="shrink-0 border-b border-border bg-muted/25 px-3.5 py-2.5"
						>
							<p className="eyebrow">Summary</p>
							<div className="mt-1.5 line-clamp-3 text-[12.5px] leading-relaxed text-muted-foreground">
								{summary}
							</div>
						</div>
					)}

					{/* Thread */}
					<div
						className="min-h-[170px] flex-1 overflow-y-auto px-4 py-3"
						onScroll={handleThreadScroll}
					>
						{nodes.length === 0 ? (
							<p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
						) : (
							<div className="space-y-1.5">
								{earlierNodes.length > 0 && !earlierExpanded && (
									<button
										type="button"
										onClick={() => setEarlierExpanded(true)}
										className="flex w-full items-center justify-center gap-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
									>
										<ArrowUp size={12} aria-hidden />
										Scroll up to load {earlierCount} earlier{' '}
										{earlierCount === 1 ? 'message' : 'messages'}
									</button>
								)}
								{earlierNodes.length > 0 && earlierExpanded && (
									<div className="space-y-1.5 opacity-70">
										{earlierNodes.map((node) => (
											<ActivityComment
												key={node.root.id}
												event={node.root}
												replies={node.replies}
												workspaceId={workspaceId}
												objectId={objectId}
												onReplyTo={handleReplyTo}
												collapsibleReplies
											/>
										))}
									</div>
								)}
								{visibleNodes.map((node) => {
									const dividerOnRoot =
										firstUnreadEventId !== null && firstUnreadEventId === node.root.id
									const dividerInsideThread =
										firstUnreadRootId === node.root.id &&
										firstUnreadEventId !== null &&
										firstUnreadEventId !== node.root.id
									const divider = (
										<NewDivider count={unreadMessageCount} onMarkRead={() => commit('mark-read')} />
									)
									return (
										<div key={node.root.id}>
											{dividerOnRoot && divider}
											<ActivityComment
												event={node.root}
												replies={node.replies}
												workspaceId={workspaceId}
												objectId={objectId}
												onReplyTo={handleReplyTo}
												collapsibleReplies
												dividerBeforeReplyId={
													dividerInsideThread ? (firstUnreadEventId ?? undefined) : undefined
												}
												divider={dividerInsideThread ? divider : undefined}
											/>
										</div>
									)
								})}
							</div>
						)}
					</div>

					{/* Footer: decision <-> receipt, quick-reply chips, composer */}
					<div className="shrink-0 border-t border-border bg-background px-4 py-3">
						{decisionActions && decisionPhase.status === 'idle' && (
							<div
								data-testid="decision-block"
								className="mb-3 flex flex-col gap-2 rounded-xl bg-status-in_review-bg p-2.5"
							>
								<div className="flex items-start gap-2 px-1">
									{latestAuthor && (
										<ActorAvatar
											name={latestAuthor.name}
											type={latestAuthor.type}
											size="sm"
											className="mt-0.5"
										/>
									)}
									<p className="min-w-0 text-[11.5px] leading-snug text-status-in_review-text">
										<span className="font-bold">
											{latestAuthor ? `${latestAuthor.name} asks` : 'Decision needed'} ·{' '}
										</span>
										{decisionPrompt(latestReply ?? latestNode?.root)}
									</p>
								</div>
								{/* Stacked full-width rows below md, one inline row from md up
								    (mockup 419–426). No `flex-wrap`: at 768 the two options plus
								    their rationales are wider than the 760px card column, and
								    wrapping put them back on separate lines at a viewport the
								    design calls inline. They shrink instead — `min-w-0` lets each
								    button drop below its content width so the label truncates. */}
								<div className="flex flex-col gap-1.5 md:flex-row">
									{decisionActions.map((action) => (
										<button
											key={action.id}
											type="button"
											data-action-id={action.id}
											className={cn(
												'flex min-h-12 w-full touch-manipulation items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-[13.5px] font-medium transition-colors md:w-auto md:min-w-0',
												action.tone === 'primary'
													? 'bg-brand text-brand-foreground hover:bg-brand-hover'
													: 'border border-border bg-background text-foreground hover:bg-secondary',
											)}
											onClick={() => chooseDecision(action)}
										>
											<span className="flex min-w-0 flex-col md:flex-row md:items-baseline md:gap-2">
												<span className="truncate font-bold">{action.label}</span>
												{action.rationale && (
													<span
														className={cn(
															'truncate text-[11px] font-normal',
															action.tone === 'primary'
																? 'text-brand-foreground/80'
																: 'text-muted-foreground',
														)}
													>
														{action.rationale}
													</span>
												)}
											</span>
											<span className="flex shrink-0 items-center gap-1.5">
												{action.recommended && (
													<span
														data-testid="decision-rec"
														className={cn(
															'rounded-[5px] px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.06em]',
															action.tone === 'primary'
																? 'bg-brand-foreground/15 text-brand-foreground'
																: 'bg-brand-subtle text-brand-subtle-foreground',
														)}
													>
														Rec
													</span>
												)}
												{action.tone === 'primary' && (
													<kbd className="rounded border border-current px-1.5 py-0.5 font-mono text-[10px] opacity-70">
														↵
													</kbd>
												)}
											</span>
										</button>
									))}
								</div>
							</div>
						)}

						{(decisionPhase.status === 'receipt' || decisionPhase.status === 'committed') && (
							<div
								data-testid="decision-receipt"
								className="mb-3 flex flex-col gap-2 rounded-xl border border-border bg-status-active-bg p-3"
							>
								<div className="flex flex-wrap items-center gap-2 text-sm font-bold text-status-active-text">
									<CheckIcon size={14} />
									You chose {decisionPhase.action.label}
									<span className="ml-auto text-[10.5px] font-medium text-status-active-text/70">
										{latestAuthor ? `${latestAuthor.name} · ` : ''}just now
									</span>
								</div>
								{/* The receipt lines describe what the choice *does*, so they
								    read the same during the reverse window and after it. */}
								<div className="space-y-1 pl-6 text-xs text-status-active-text/80">
									<p className="flex items-center gap-1.5">
										<CheckIcon size={12} />
										Your choice was posted to the thread
									</p>
									<p className="flex items-center gap-1.5">
										<CheckIcon size={12} />
										Card marked read and advanced
									</p>
								</div>
								{decisionPhase.status === 'receipt' && (
									<div className="flex flex-wrap items-center gap-2.5 pl-6">
										<Button
											size="sm"
											variant="outline"
											className="h-7 bg-background text-xs"
											onClick={reverseDecision}
										>
											Reverse this
										</Button>
										<span className="text-xs text-muted-foreground">
											Reversible for {secondsLeft}s
										</span>
									</div>
								)}
							</div>
						)}

						{showChips && (
							<div
								data-testid="chip-row"
								className="mb-3 flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
							>
								{chipActions.map((action) => (
									<button
										key={action.id}
										type="button"
										data-action-id={action.id}
										className={cn(
											'shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50',
											action.tone === 'primary'
												? 'border-brand bg-brand text-brand-foreground hover:bg-brand-hover'
												: 'border-border bg-background text-muted-foreground hover:border-foreground hover:bg-secondary hover:text-foreground',
										)}
										onClick={() => runQuickReply(action)}
										disabled={quickReply.isPending}
									>
										{action.label}
									</button>
								))}
							</div>
						)}

						{replyTo && (
							<div
								data-testid="reply-banner"
								className="mb-1.5 flex items-center gap-2 rounded-[9px] border border-brand-subtle-foreground/30 bg-brand-subtle py-1.5 pl-3 pr-2.5 text-[11.5px] text-brand-subtle-foreground"
							>
								<CornerDownLeft size={12} aria-hidden className="shrink-0" />
								<span className="min-w-0 flex-1 truncate">
									Replying to <span className="font-bold">{replyTo.name}</span>
								</span>
								<button
									type="button"
									onClick={() => setReplyTo(null)}
									aria-label="Cancel reply"
									className="grid size-[22px] shrink-0 place-items-center rounded-md hover:bg-brand-subtle-foreground/15"
								>
									<X size={12} aria-hidden />
								</button>
							</div>
						)}

						<CommentInput
							workspaceId={workspaceId}
							objectId={objectId}
							parentEventId={activeReplyTarget}
							mentionDropdownPlacement="above"
							onSubmitted={() => setReplyTo(null)}
						/>
					</div>
				</div>
			</div>
		)
	},
)

// The prompt shown beside "{who} asks ·" — the newest message's own text, so
// the decision block quotes what was actually said rather than a canned string.
function decisionPrompt(event: { data?: Record<string, unknown> | null } | undefined): string {
	const content = event?.data?.content
	return typeof content === 'string' && content.trim().length > 0
		? content.trim()
		: 'needs your decision on this thread.'
}

function NewDivider({ count, onMarkRead }: { count: number; onMarkRead: () => void }) {
	return (
		<div className="my-2 flex items-center gap-2" aria-label="Unread divider">
			<div className="h-px flex-1 bg-brand-subtle-foreground/30" />
			{/* The `.eyebrow` utility locks its colour to muted-foreground by
			    design; this label is indigo-on-indigo, so the mono micro-label
			    recipe is spelled out here instead of fighting that lock. */}
			<span className="shrink-0 rounded-full bg-brand-subtle px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.11em] text-brand-subtle-foreground">
				{count} new {count === 1 ? 'message' : 'messages'}
			</span>
			<button
				type="button"
				onClick={onMarkRead}
				className="shrink-0 text-[10.5px] font-semibold text-muted-foreground hover:text-foreground"
			>
				Mark read
			</button>
			<div className="h-px w-3 shrink-0 bg-brand-subtle-foreground/30" />
		</div>
	)
}
