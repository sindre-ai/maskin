import { ActivityComment } from '@/components/activity/activity-comment'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useCreateComment, useEntityEvents } from '@/hooks/use-events'
import { useIsMobile } from '@/hooks/use-mobile'
import { useObjectGraph } from '@/hooks/use-objects'
import { useMarkRead, useMarkUnread } from '@/hooks/use-subscriptions'
import { useSwipeToMarkRead } from '@/hooks/use-swipe-to-mark-read'
import { trackForyouCardAction, trackForyouCardShown } from '@/lib/analytics'
import type { EventResponse, UnreadItem } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import {
	CARD_ACTIONS,
	type CardAction,
	type CardKind,
	classifyCardKind,
} from '@/lib/foryou-card-kind'
import { Link } from '@tanstack/react-router'
import { CheckIcon, MailIcon, XIcon } from 'lucide-react'
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { toast } from 'sonner'

interface UnreadThreadCardProps {
	workspaceId: string
	item: UnreadItem
	isActive: boolean
	onActivate: () => void
	// Reports the event id a reply should nest under (the first unread root, or
	// the latest thread if nothing's unread) whenever this card is active and
	// that target changes — so PersistentReplyBar can thread its replies
	// correctly. Only fires while isActive; other cards' updates are ignored.
	onReplyTargetChange: (replyTarget: number | null) => void
	// `cards` (default) shows kind-specific affordances (decision footer or
	// chip-row). `list` collapses to a single-line row — hides the affordance
	// zone entirely so List mode has no inline actions on any kind (T2/T3 AC).
	mode?: 'cards' | 'list'
}

interface CommentNode {
	root: EventResponse
	replies: EventResponse[]
}

// Fallback chips used when a card doesn't map to a specific action-UI kind
// (decision / sign_off / proposed_bet). Keeps the pre-redesign feel on plain
// threads so we don't regress non-decision items.
const QUICK_REPLY_CHIPS: readonly CardAction[] = [
	{ id: 'on_it', label: 'On it', tone: 'secondary' },
	{ id: 'approved', label: 'Approved', tone: 'secondary' },
	{ id: 'looks_good', label: 'Looks good', tone: 'secondary' },
	{ id: 'need_context', label: 'Need more context', tone: 'secondary' },
]

// Cards within this distance of the viewport start fetching their events, so
// the next card or two below the fold is ready by the time the user scrolls.
const PREFETCH_ROOT_MARGIN = '400px'

export function UnreadThreadCard({
	workspaceId,
	item,
	isActive,
	onActivate,
	onReplyTargetChange,
	mode = 'cards',
}: UnreadThreadCardProps) {
	const objectId = item.entity_id

	const cardRef = useRef<HTMLDivElement>(null)
	const [hasBeenVisible, setHasBeenVisible] = useState(false)
	useEffect(() => {
		if (hasBeenVisible) return
		const node = cardRef.current
		if (!node) return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setHasBeenVisible(true)
					observer.disconnect()
				}
			},
			{ rootMargin: PREFETCH_ROOT_MARGIN },
		)
		observer.observe(node)
		return () => observer.disconnect()
	}, [hasBeenVisible])

	const cardKind: CardKind = classifyCardKind(item)

	// Fires once per mount, on the first IntersectionObserver hit — the natural
	// impression signal. The observer disconnects immediately after, so remount
	// (scroll off + back) is the only way to re-fire, matching PostHog's
	// intent-per-view expectation for the success-metric denominator.
	const impressionFiredRef = useRef(false)
	useEffect(() => {
		if (!hasBeenVisible || impressionFiredRef.current) return
		impressionFiredRef.current = true
		trackForyouCardShown({ card_kind: cardKind, card_id: objectId })
	}, [hasBeenVisible, cardKind, objectId])

	const emitAction = useCallback(
		(actionId: string) => {
			trackForyouCardAction({ card_kind: cardKind, card_id: objectId, action_id: actionId })
		},
		[cardKind, objectId],
	)

	const { data: events } = useEntityEvents(workspaceId, objectId, {
		enabled: hasBeenVisible,
	})
	const currentActorId = getStoredActor()?.id ?? null

	const { nodes, firstUnreadRootId, firstUnreadEventId, latestRootId, latestEventId } =
		useMemo(() => {
			if (!events) {
				return {
					nodes: [] as CommentNode[],
					firstUnreadRootId: null as number | null,
					firstUnreadEventId: null as number | null,
					latestRootId: null as number | null,
					latestEventId: 0,
				}
			}
			const chronological = [...events].reverse()

			const repliesByParent = new Map<number, EventResponse[]>()
			const roots: EventResponse[] = []
			for (const event of chronological) {
				if (event.action !== 'commented') continue
				const parentId = event.data?.parentEventId as number | undefined
				if (parentId) {
					const list = repliesByParent.get(parentId) ?? []
					list.push(event)
					repliesByParent.set(parentId, list)
					continue
				}
				roots.push(event)
			}

			const built: CommentNode[] = roots.map((root) => ({
				root,
				replies: repliesByParent.get(root.id) ?? [],
			}))

			let maxId = 0
			for (const node of built) {
				if (node.root.id > maxId) maxId = node.root.id
				for (const reply of node.replies) if (reply.id > maxId) maxId = reply.id
			}

			// Walk the *flat* timeline (root + replies in chronological order)
			// from the newest backward, counting comments that don't belong to
			// the viewer. item.unread_count anchors the boundary so the divider
			// always reflects the server's count even when the local event list
			// is partial.
			const flat: { rootId: number; eventId: number; actorId: string }[] = []
			for (const node of built) {
				flat.push({ rootId: node.root.id, eventId: node.root.id, actorId: node.root.actorId })
				for (const reply of node.replies) {
					flat.push({ rootId: node.root.id, eventId: reply.id, actorId: reply.actorId })
				}
			}

			const targetCount = item.unread_count
			let counted = 0
			let boundaryRootId: number | null = null
			let boundaryEventId: number | null = null
			let oldestUnreadRootId: number | null = null
			let oldestUnreadEventId: number | null = null
			for (let i = flat.length - 1; i >= 0 && counted < targetCount; i--) {
				const entry = flat[i]
				if (!entry) continue
				if (currentActorId && entry.actorId === currentActorId) continue
				counted++
				oldestUnreadRootId = entry.rootId
				oldestUnreadEventId = entry.eventId
				if (counted === targetCount) {
					boundaryRootId = entry.rootId
					boundaryEventId = entry.eventId
				}
			}

			// If the server reports more unread events than we have loaded (the
			// events query is capped at 50), anchor to the oldest non-viewer comment
			// in the loaded window so the divider still appears above visible unread activity.
			if (boundaryEventId === null && targetCount > 0 && oldestUnreadEventId !== null) {
				boundaryRootId = oldestUnreadRootId
				boundaryEventId = oldestUnreadEventId
			}

			const lastNode = built.length > 0 ? built[built.length - 1] : null

			return {
				nodes: built,
				firstUnreadRootId: boundaryRootId,
				firstUnreadEventId: boundaryEventId,
				latestRootId: lastNode?.root.id ?? null,
				latestEventId: maxId,
			}
		}, [events, item.unread_count, currentActorId])

	const markRead = useMarkRead(workspaceId)
	const handleMarkRead = useCallback(() => {
		const target = Math.max(item.latest_event_id ?? 0, latestEventId)
		if (target <= 0) return
		markRead.mutate({ entityType: item.entity_type, entityId: objectId, lastEventId: target })
	}, [markRead, item.entity_type, objectId, item.latest_event_id, latestEventId])

	const markUnread = useMarkUnread(workspaceId)
	const handleMarkUnread = useCallback(() => {
		markUnread.mutate({ entityType: item.entity_type, entityId: objectId })
	}, [markUnread, item.entity_type, objectId])

	// Reply target for both quick-reply chips (below) and the PersistentReplyBar
	// (via onReplyTargetChange): nest under the first unread thread, or the
	// latest thread if nothing's unread — same target the old per-card
	// CommentInput used, so replies land in the right thread instead of
	// starting a new top-level conversation.
	const replyTarget = firstUnreadRootId ?? latestRootId ?? undefined

	useEffect(() => {
		if (!isActive) return
		onReplyTargetChange(replyTarget ?? null)
	}, [isActive, replyTarget, onReplyTargetChange])

	const quickReply = useCreateComment(workspaceId, objectId)

	const handleCardClick = useCallback(
		(e: ReactMouseEvent) => {
			if ((e.target as HTMLElement).closest('button, a')) return
			onActivate()
		},
		[onActivate],
	)

	const handleReplyClick = useCallback(
		(e: ReactMouseEvent) => {
			e.stopPropagation()
			emitAction('reply')
			onActivate()
		},
		[onActivate, emitAction],
	)

	const isRead = item.unread_count === 0
	const {
		dragOffset,
		isDragging,
		swipePending,
		swipeBgOpacity,
		revealVariant,
		handlePointerDown,
		handlePointerMove,
		handlePointerUp,
		handlePointerCancel,
	} = useSwipeToMarkRead({
		onMarkRead: handleMarkRead,
		onMarkUnread: handleMarkUnread,
		isRead,
		analytics: { entity_type: item.entity_type, entity_id: objectId },
	})

	const title = item.object?.title ?? 'Untitled'
	const objectType = item.object?.type
	const objectStatus = item.object?.status
	const insightPreview = (item.object?.content ?? '').trim()
	const isUnread = item.unread_count > 0
	const isMention = item.mentioning_unread_count > 0
	const isListMode = mode === 'list'
	const isMobileViewport = useIsMobile()
	// Kind-specific action set; `thread` reuses the generic quick-reply chips
	// so nothing regresses on non-decision items.
	const chipActions: readonly CardAction[] =
		cardKind === 'sign_off' || cardKind === 'proposed_bet'
			? CARD_ACTIONS[cardKind]
			: QUICK_REPLY_CHIPS
	const decisionActions: readonly CardAction[] | null =
		cardKind === 'decision' ? CARD_ACTIONS.decision : null

	// Decision cards mirror the task's parent bet so the human can see which
	// bet the call belongs to without opening the object. `enabled` gates
	// the network call itself, so non-decision feed rows never fire.
	const graphQuery = useObjectGraph(workspaceId, objectId, {
		enabled: cardKind === 'decision',
	})
	const parentBet =
		cardKind === 'decision' && graphQuery.data
			? (graphQuery.data.relationships
					.filter(
						(rel) =>
							rel.type === 'breaks_into' &&
							rel.targetId === objectId &&
							rel.sourceType === 'object',
					)
					.map((rel) => graphQuery.data?.connected_objects.find((o) => o.id === rel.sourceId))
					.find((obj) => obj?.type === 'bet') ?? null)
			: null

	const runCardAction = useCallback(
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

	return (
		// Outer wrapper holds the swipe-reveal background; the card translates over it.
		// One overlay per direction, keyed off revealVariant so a wrong-direction
		// swipe (which clamps dragOffset to 0 in the hook) never leaks the wrong
		// colour behind the card.
		<div ref={cardRef} data-testid="unread-thread-card" className="relative overflow-hidden">
			{revealVariant === 'mark-read' ? (
				<div
					aria-hidden
					data-testid="mark-read-reveal"
					className="pointer-events-none absolute inset-0 flex items-center gap-2 bg-status-active-bg px-5 text-xs font-medium text-status-active-text"
					style={{ opacity: isDragging ? swipeBgOpacity : 0 }}
				>
					<CheckIcon size={14} />
					Mark read
				</div>
			) : (
				<div
					aria-hidden
					data-testid="mark-unread-reveal"
					className="pointer-events-none absolute inset-0 flex items-center justify-end gap-2 bg-status-in_progress-bg px-5 text-xs font-medium text-status-in_progress-text"
					style={{ opacity: isDragging ? swipeBgOpacity : 0 }}
				>
					<MailIcon size={14} />
					Mark unread
				</div>
			)}

			{/* biome-ignore lint/a11y/useKeyWithClickEvents: card click supplements inner buttons/links, which keyboard users tab to and activate directly */}
			<div
				data-card-kind={cardKind}
				data-view-mode={mode}
				className={cn(
					// Hairline top-rule for the shared-rhythm feel; no outer ring or bg-card shell.
					'group relative border-t border-border bg-background pt-3 pb-2.5 pl-3 pr-3 cursor-pointer touch-pan-y',
					isDragging
						? 'transition-none'
						: 'transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
					swipePending ? 'opacity-35' : 'transition-opacity duration-200',
					// Unread accent as a 2px left border (bg-primary in default mode; bg-warning
					// when the viewer was @-mentioned in an unread event).
					isUnread && 'border-l-2 pl-[10px]',
					isUnread && !isMention && 'border-l-primary',
					isUnread && isMention && 'border-l-warning',
					// Muted read-card style so a recently-read card in the mixed feed reads
					// as "already seen" without disappearing. Opacity + a hairline left rail
					// mirror the unread accent's silhouette so the feed rhythm stays even.
					isRead && 'opacity-[0.78] border-l-2 border-l-border pl-[10px]',
					isActive && 'bg-secondary/40',
					// List mode collapses the row visually so multi-line body/threads don't
					// waste vertical space; kind-specific affordances are hidden below.
					isListMode && 'pt-2 pb-2',
				)}
				style={{ transform: `translateX(${dragOffset}px)` }}
				onClick={handleCardClick}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerCancel}
			>
				{/* Card head — type + state chip + spacer + per-card dismiss.
				    Dismiss is hover/focus-only on hoverable devices (a corner ✓ on desktop);
				    on touch, swipe-left mark-read replaces it. */}
				<div className="flex items-center gap-1.5">
					{objectType === 'bet' && (
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="inline-flex shrink-0 items-center rounded bg-type-bet-bg px-1.5 py-0.5 text-[10px] font-semibold text-type-bet-text">
										B
									</span>
								</TooltipTrigger>
								<TooltipContent side="bottom" className="text-xs">
									{title}
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					)}
					{objectType && <TypeBadge type={objectType} />}
					{objectStatus && <StatusBadge status={objectStatus} variant="dot-word" />}
					<span className="flex-1" />
					<button
						type="button"
						aria-label="Mark as read"
						title="Mark as read"
						onClick={(e) => {
							e.stopPropagation()
							emitAction('mark_read_corner')
							handleMarkRead()
						}}
						disabled={markRead.isPending}
						/* Desktop-only: hidden on touch (no hover), fades in on hover/focus with mouse. */
						className="hidden can-hover:inline-grid h-7 w-7 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-secondary hover:text-foreground disabled:opacity-40"
					>
						<XIcon size={14} />
					</button>
				</div>

				{/* Title on its own row, left-aligned.
				    basis-full flex-wrap kept for regression: long titles push the meta
				    row below on mobile (375px), single line at sm+. */}
				<Link
					to="/$workspaceId/objects/$objectId"
					params={{ workspaceId, objectId }}
					className={cn(
						'mt-2 block truncate text-[15px] font-semibold leading-snug hover:underline',
						isUnread ? 'text-foreground' : 'text-muted-foreground',
					)}
					title={title}
					onClick={(e) => e.stopPropagation()}
				>
					{title}
				</Link>

				{/* Meta row: mention flag → unread count → timestamp. */}
				<div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
					{isMention && (
						<>
							<span
								aria-label="Mentioned"
								title="You were @-mentioned in an unread comment"
								className="font-semibold text-warning"
							>
								@mention
							</span>
							<span aria-hidden className="opacity-50">
								·
							</span>
						</>
					)}
					{item.unread_count > 0 && (
						<>
							<span
								aria-label={`${item.unread_count} unread`}
								className={cn(
									'tabular-nums',
									isUnread ? 'font-medium text-foreground' : 'text-muted-foreground',
								)}
							>
								{item.unread_count} new
							</span>
							<span aria-hidden className="opacity-50">
								·
							</span>
						</>
					)}
					{item.latest_activity_at && (
						<RelativeTime
							date={item.latest_activity_at}
							className="font-mono tabular-nums text-muted-foreground"
						/>
					)}
				</div>

				{/* Body, thread, and inline actions are only rendered in Cards mode.
				    List mode collapses the row to the head/title/meta above so the feed
				    reads as a scannable stream with no inline chips or buttons — the
				    task's List-mode AC. */}
				{!isListMode && (
					<>
						{/* Decision cards mirror the parent bet so the human knows which
						    bet the call belongs to without opening the object. */}
						{parentBet && (
							<Link
								to="/$workspaceId/objects/$objectId"
								params={{ workspaceId, objectId: parentBet.id }}
								data-testid="parent-bet-context"
								className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
								onClick={(e) => e.stopPropagation()}
							>
								<span className="inline-flex shrink-0 items-center rounded bg-type-bet-bg px-1.5 py-0.5 text-[10px] font-semibold text-type-bet-text">
									B
								</span>
								<span className="truncate">{parentBet.title ?? 'Untitled bet'}</span>
							</Link>
						)}
						{/* 2-line insight preview from the object body (the "what this thread is about"
						    hook that leads before the agent take, per AC-U7). */}
						{insightPreview && (
							<p className="mt-2 line-clamp-2 text-[13.5px] leading-relaxed text-muted-foreground">
								{insightPreview}
							</p>
						)}

						{/* Thread — all messages inline, page scrolls naturally.
						    Dashed hairline separates the insight preview above from the agent take
						    to match the prototype's `border-t dashed` rhythm. */}
						<div className="mt-2.5 border-t border-dashed border-border pt-2.5">
							{nodes.length === 0 ? (
								<p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
							) : (
								<div className="space-y-1">
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

						{/* Kind-specific chip-row for sign_off / proposed_bet (and the generic
						    thread fallback). Decision cards render the shaded footer instead
						    (below the Reply/Mark-as-read row). */}
						{!decisionActions && (
							<div
								data-testid="chip-row"
								data-chip-row={cardKind}
								className="mt-2 flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
												: 'border-border bg-background text-muted-foreground hover:border-foreground hover:bg-secondary hover:text-foreground active:bg-foreground active:text-background',
										)}
										onClick={(e) => {
											e.stopPropagation()
											runCardAction(action)
										}}
										disabled={quickReply.isPending}
									>
										{action.label}
									</button>
								))}
							</div>
						)}

						{/* Footer: Reply + Mark read */}
						<div className="mt-1.5 flex items-center gap-1">
							<Button
								size="sm"
								variant="outline"
								className={cn(
									'h-7 px-2 text-xs font-medium',
									isActive &&
										'bg-foreground text-background border-foreground hover:bg-foreground/90',
								)}
								onClick={handleReplyClick}
							>
								{isActive ? 'Replying…' : 'Reply'}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="h-7 px-2 text-xs"
								onClick={(e) => {
									e.stopPropagation()
									emitAction('mark_read_button')
									handleMarkRead()
								}}
								disabled={markRead.isPending}
							>
								Mark as read
							</Button>
						</div>

						{/* Decision cards: shaded footer bar with full-width primary/secondary
						    buttons. Uses --st-in_review-bg to signal "needs a call" weight —
						    the load-bearing distinction the bet is testing. Negative margins
						    pull it flush to the row edges; buttons stack vertically at 375.
						    `data-stack-layout` exposes the layout to Playwright so the mobile
						    stack assertion doesn't have to measure pixel widths. */}
						{decisionActions && (
							<div
								data-testid="decision-footer"
								data-stack-layout={isMobileViewport ? 'stacked' : 'row'}
								className={cn(
									'mt-3 -mx-3 -mb-2.5 flex flex-col gap-2 border-t border-border/70 bg-status-in_review-bg px-3 py-3',
									'md:flex-row',
									// Undo the outer `pl-[10px]` when the row itself carries the unread
									// accent so the footer still lines up with the card's left edge.
									(isUnread || isRead) && '-ml-[10px]',
								)}
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
										onClick={(e) => {
											e.stopPropagation()
											runCardAction(action)
										}}
										disabled={quickReply.isPending}
									>
										{action.label}
									</Button>
								))}
							</div>
						)}
					</>
				)}
			</div>
		</div>
	)
}

function NewDivider() {
	return (
		<div className="my-2 flex items-center gap-2" aria-label="Unread divider">
			<div className="h-px flex-1 bg-warning/55" />
			<span className="text-[10.5px] font-semibold uppercase tracking-wider text-warning">New</span>
			<div className="h-px flex-1 bg-warning/55" />
		</div>
	)
}
