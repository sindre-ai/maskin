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
import { Link } from '@tanstack/react-router'
import { CheckIcon } from 'lucide-react'
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

// Honest, short reversible window for a decision commit — long enough to read
// the receipt and change your mind. Not the mockup's fabricated "Reversible
// for 2h" — a real durable multi-hour window needs a backend pending-decision
// table this canary doesn't have.
const DECISION_REVERSE_WINDOW_MS = 6000

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
		})

		// "Keep unread" is a pure skip — no mutation, no undo, distinct from the
		// hook's mark-unread variant (which reverses a previously *read* item;
		// queue cards are always unread). Exposed only via the fixed action bar,
		// not drag — left-drag tracking is out of scope for v1.
		const handleSkip = useCallback(() => {
			emitAction('keep_unread')
			beginExit('left')
		}, [emitAction, beginExit])

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
			exitDir === 'right' ? 'translateX(140%)' : exitDir === 'left' ? 'translateX(-140%)' : null

		return (
			<div ref={threadRef} className="relative mx-auto w-full max-w-[760px]">
				<div
					aria-hidden
					data-testid="mark-read-reveal"
					className="pointer-events-none absolute inset-0 flex items-center justify-end gap-2 rounded-[18px] bg-status-active-bg px-5 text-xs font-medium text-status-active-text"
					style={{ opacity: isDragging ? swipeBgOpacity : 0 }}
				>
					<CheckIcon size={14} />
					Mark as read
				</div>

				<div
					data-testid="foryou-queue-card"
					data-card-kind={cardKind}
					className={cn(
						'relative flex max-h-[min(680px,calc(100vh-220px))] flex-col overflow-hidden rounded-[18px] border border-border bg-background shadow-md cursor-grab touch-pan-y',
						exitDir
							? 'transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]'
							: isDragging
								? 'transition-none'
								: 'transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
					)}
					style={{
						transform: exitTransform ?? `translateX(${dragOffset}px)`,
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
								{objectType && <span className="capitalize">{objectType}</span>}
								{objectStatus && (
									<>
										<span aria-hidden className="opacity-50">
											·
										</span>
										<StatusBadge status={objectStatus} variant="dot-word" />
									</>
								)}
								{item.latest_activity_at && (
									<>
										<span aria-hidden className="opacity-50">
											·
										</span>
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
							<p className="text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">
								✦ Summary
							</p>
							<p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">
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
								className="mb-3 flex flex-col gap-2 rounded-md bg-status-in_review-bg p-3 md:flex-row"
							>
								{decisionActions.map((action) => (
									<Button
										key={action.id}
										size="sm"
										variant={action.tone === 'primary' ? 'default' : 'outline'}
										data-action-id={action.id}
										className={cn(
											'h-9 flex-1 justify-center text-sm font-medium',
											action.tone === 'secondary' && 'bg-background',
										)}
										onClick={() => chooseDecision(action)}
									>
										{action.label}
									</Button>
								))}
							</div>
						)}

						{decisionPhase.status === 'receipt' && (
							<div
								data-testid="decision-receipt"
								className="mb-3 rounded-md border border-border bg-status-active-bg p-3"
							>
								<div className="flex items-center gap-2 text-sm font-medium text-status-active-text">
									<CheckIcon size={14} />
									You chose {decisionPhase.action.label}
								</div>
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
							</div>
						)}

						{!decisionActions && (
							<div className="mb-3 flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
