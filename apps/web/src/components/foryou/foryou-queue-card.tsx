import { ActivityComment } from '@/components/activity/activity-comment'
import { CommentInput } from '@/components/activity/comment-input'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import { useEntityThread } from '@/hooks/use-entity-thread'
import { useCreateComment } from '@/hooks/use-events'
import { useMarkRead } from '@/hooks/use-subscriptions'
import { useSwipeToMarkRead } from '@/hooks/use-swipe-to-mark-read'
import { trackForyouCardAction, trackForyouCardShown } from '@/lib/analytics'
import type { UnreadItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
	CARD_ACTIONS,
	type CardAction,
	type CardKind,
	QUICK_REPLY_CHIPS,
	classifyCardKind,
} from '@/lib/foryou-card-kind'
import { DECISION_REVERSE_WINDOW_MS } from '@/lib/foryou-decision'
import { isValidRequestDecisionMetadata } from '@maskin/shared'
import { Link } from '@tanstack/react-router'
import { CheckIcon, X } from 'lucide-react'
import {
	type TransitionEvent,
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from 'react'
import { toast } from 'sonner'

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

		// Schema-compliance flag on both events. UnreadItem is the pre-Stage-1
		// thread payload, which carries no notification metadata — so this
		// resolves to `false` today (baseline per T7 DoD #5). Once T5/T6 pipe
		// a notification's metadata onto the item, the same helper will flip
		// schema-compliant asks to `true` without touching call sites here.
		const notificationMetadata = (item as { notification_metadata?: unknown }).notification_metadata
		const schemaValid = isValidRequestDecisionMetadata(notificationMetadata)

		const impressionFiredRef = useRef(false)
		useEffect(() => {
			if (impressionFiredRef.current) return
			impressionFiredRef.current = true
			trackForyouCardShown({ card_kind: cardKind, card_id: objectId, schema_valid: schemaValid })
		}, [cardKind, objectId, schemaValid])

		const emitAction = useCallback(
			(actionId: string) => {
				trackForyouCardAction({
					card_kind: cardKind,
					card_id: objectId,
					action_id: actionId,
					schema_valid: schemaValid,
				})
			},
			[cardKind, objectId, schemaValid],
		)

		const markRead = useMarkRead(workspaceId)
		const handleMarkRead = useCallback(() => {
			const target = Math.max(item.latest_event_id ?? 0, latestEventId)
			if (target <= 0) return
			markRead.mutate({ entityType: item.entity_type, entityId: objectId, lastEventId: target })
		}, [markRead, item.entity_type, objectId, item.latest_event_id, latestEventId])

		const replyTarget = firstUnreadRootId ?? latestRootId ?? undefined
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

		const [summaryExpanded, setSummaryExpanded] = useState(false)

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
						{ entity_id: objectId, content: action.label, parent_event_id: replyTarget },
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
			[emitAction, quickReply, objectId, replyTarget, handleMarkRead, beginExit],
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
					{ entity_id: objectId, content: action.label, parent_event_id: replyTarget },
					{
						onSuccess: () => {
							handleMarkRead()
							toast(`✓ ${action.label}`)
						},
					},
				)
			},
			[quickReply, objectId, replyTarget, handleMarkRead, emitAction],
		)

		useImperativeHandle(ref, () => ({ commit: () => commit('mark-read'), skip: handleSkip }), [
			commit,
			handleSkip,
		])

		const title = item.object?.title ?? 'Untitled'
		const objectType = item.object?.type
		const objectStatus = item.object?.status
		const insightPreview = (item.object?.content ?? '').trim()
		const chipActions: readonly CardAction[] =
			cardKind === 'sign_off' || cardKind === 'proposed_bet'
				? CARD_ACTIONS[cardKind]
				: QUICK_REPLY_CHIPS
		const decisionActions: readonly CardAction[] | null =
			cardKind === 'decision' ? CARD_ACTIONS.decision : null

		const exitTransform =
			exitDir === 'right'
				? 'translateX(140%) rotate(8deg)'
				: exitDir === 'left'
					? 'translateX(-140%) rotate(-8deg)'
					: null
		const dragTransform = `translateX(${dragOffset}px) rotate(${dragOffset / 24}deg)`

		return (
			<div ref={threadRef} className="relative mx-auto h-full w-full max-w-[760px]">
				<div
					aria-hidden
					data-testid="mark-read-reveal"
					className="pointer-events-none absolute inset-0 flex items-center justify-end gap-2 rounded-[18px] bg-status-active-bg px-5 text-xs font-medium text-status-active-text"
					style={{ opacity: isDragging && dragOffset > 0 ? swipeBgOpacity : 0 }}
				>
					<CheckIcon size={14} />
					Mark as read
				</div>

				<div
					aria-hidden
					data-testid="keep-unread-reveal"
					className="pointer-events-none absolute inset-0 flex items-center justify-start gap-2 rounded-[18px] bg-muted px-5 text-xs font-medium text-muted-foreground"
					style={{ opacity: isDragging && dragOffset < 0 ? swipeBgOpacity : 0 }}
				>
					<X size={14} />
					Keep unread
				</div>

				<div
					data-testid="foryou-queue-card"
					data-card-kind={cardKind}
					className={cn(
						'relative flex h-full flex-col overflow-hidden rounded-[18px] border border-border bg-background shadow-md cursor-grab touch-pan-y',
						exitDir
							? 'transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]'
							: isDragging
								? 'transition-none'
								: 'transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
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
					{/* Header */}
					<div className="flex items-start gap-3 border-b border-border px-4 py-3">
						{objectType && <TypeBadge type={objectType} />}
						<div className="min-w-0 flex-1">
							<Link
								to="/$workspaceId/objects/$objectId"
								params={{ workspaceId, objectId }}
								className="block truncate text-[15px] font-semibold leading-snug text-foreground hover:underline"
								title={title}
							>
								{title}
							</Link>
							<div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
								{objectStatus && <StatusBadge status={objectStatus} variant="dot-word" />}
								{item.latest_activity_at && (
									<>
										{objectStatus && (
											<span aria-hidden className="opacity-50">
												·
											</span>
										)}
										<RelativeTime
											date={item.latest_activity_at}
											className="font-mono tabular-nums"
										/>
									</>
								)}
							</div>
						</div>
						<Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" asChild>
							<Link to="/$workspaceId/objects/$objectId" params={{ workspaceId, objectId }}>
								Open →
							</Link>
						</Button>
					</div>

					{/* Summary strip */}
					{insightPreview && (
						<div className="border-b border-border bg-secondary/25 px-4 py-2.5">
							<div className="flex items-center justify-between gap-2">
								<p className="text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">
									✦ Summary
								</p>
								<button
									type="button"
									onClick={() => setSummaryExpanded((v) => !v)}
									className="shrink-0 text-[10.5px] font-medium text-muted-foreground hover:text-foreground"
								>
									{summaryExpanded ? 'Hide' : 'Show full'}
								</button>
							</div>
							<p
								className={cn(
									'mt-1 text-[13px] leading-relaxed text-muted-foreground',
									!summaryExpanded && 'line-clamp-3',
								)}
							>
								{insightPreview}
							</p>
						</div>
					)}

					{/* Thread */}
					<div className="min-h-[170px] flex-1 overflow-y-auto px-4 py-3">
						{nodes.length === 0 ? (
							<p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
						) : (
							<div className="space-y-1.5">
								{nodes.map((node) => {
									const dividerOnRoot =
										firstUnreadEventId !== null && firstUnreadEventId === node.root.id
									const dividerInsideThread =
										firstUnreadRootId === node.root.id &&
										firstUnreadEventId !== null &&
										firstUnreadEventId !== node.root.id
									return (
										<div key={node.root.id}>
											{dividerOnRoot && <NewDivider />}
											<ActivityComment
												event={node.root}
												replies={node.replies}
												workspaceId={workspaceId}
												objectId={objectId}
												dividerBeforeReplyId={
													dividerInsideThread ? (firstUnreadEventId ?? undefined) : undefined
												}
												divider={dividerInsideThread ? <NewDivider /> : undefined}
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
								className="mb-3 rounded-md bg-status-in_review-bg p-2.5"
							>
								<div className="flex items-center gap-2 px-1 pb-2">
									<span className="text-[12px] font-semibold text-status-in_review-text">
										Decision needed
									</span>
								</div>
								<div className="flex flex-col gap-1.5">
									{decisionActions.map((action) => (
										<button
											key={action.id}
											type="button"
											data-action-id={action.id}
											className={cn(
												'flex min-h-12 w-full touch-manipulation items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-[13.5px] font-medium transition-colors',
												action.tone === 'primary'
													? 'bg-foreground text-background hover:bg-foreground/90'
													: 'border border-border bg-background text-foreground hover:bg-secondary',
											)}
											onClick={() => chooseDecision(action)}
										>
											<span className="flex min-w-0 flex-col">
												<span className="truncate">{action.label}</span>
												{action.rationale && (
													<span
														className={cn(
															'truncate text-[11px] font-normal',
															action.tone === 'primary'
																? 'text-background/70'
																: 'text-muted-foreground',
														)}
													>
														{action.rationale}
													</span>
												)}
											</span>
											{action.tone === 'primary' && (
												<kbd className="shrink-0 rounded border border-current px-1.5 py-0.5 font-mono text-[10px] opacity-70">
													↵
												</kbd>
											)}
										</button>
									))}
								</div>
							</div>
						)}

						{(decisionPhase.status === 'receipt' || decisionPhase.status === 'committed') && (
							<div
								data-testid="decision-receipt"
								className="mb-3 rounded-md border border-border bg-status-active-bg p-3"
							>
								<div className="flex items-center gap-2 text-sm font-medium text-status-active-text">
									<CheckIcon size={14} />
									You chose {decisionPhase.action.label}
								</div>
								{decisionPhase.status === 'committed' ? (
									<div className="mt-2 space-y-1 border-t border-status-active-text/20 pt-2 text-xs text-status-active-text/80">
										<p className="flex items-center gap-1.5">
											<CheckIcon size={12} />
											Your choice was posted to the thread
										</p>
										<p className="flex items-center gap-1.5">
											<CheckIcon size={12} />
											Card marked read and advanced
										</p>
									</div>
								) : (
									<div className="mt-2 flex items-center justify-between gap-2">
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

						{!decisionActions && (
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
												? 'border-foreground bg-foreground text-background hover:bg-foreground/90'
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

						<CommentInput
							workspaceId={workspaceId}
							objectId={objectId}
							parentEventId={replyTarget}
							mentionDropdownPlacement="above"
						/>
					</div>
				</div>
			</div>
		)
	},
)

function NewDivider() {
	return (
		<div className="my-2 flex items-center gap-2" aria-label="Unread divider">
			<div className="h-px flex-1 bg-warning/55" />
			<span className="text-[10.5px] font-semibold uppercase tracking-wider text-warning">New</span>
			<div className="h-px flex-1 bg-warning/55" />
		</div>
	)
}
