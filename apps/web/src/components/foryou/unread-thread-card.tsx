import { ActivityComment } from '@/components/activity/activity-comment'
import { RelativeTime } from '@/components/shared/relative-time'
import { TypeBadge } from '@/components/shared/type-badge'
import { UnreadBadge } from '@/components/shared/unread-badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useCreateComment, useEntityEvents } from '@/hooks/use-events'
import { useMarkRead } from '@/hooks/use-subscriptions'
import { useSwipeToMarkRead } from '@/hooks/use-swipe-to-mark-read'
import type { EventResponse, UnreadItem } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { CheckIcon } from 'lucide-react'
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
}

interface CommentNode {
	root: EventResponse
	replies: EventResponse[]
}

const QUICK_REPLY_CHIPS = ['On it', 'Approved', 'Looks good', 'Need more context'] as const

// Cards within this distance of the viewport start fetching their events, so
// the next card or two below the fold is ready by the time the user scrolls.
const PREFETCH_ROOT_MARGIN = '400px'

export function UnreadThreadCard({
	workspaceId,
	item,
	isActive,
	onActivate,
	onReplyTargetChange,
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
			onActivate()
		},
		[onActivate],
	)

	const {
		dragOffset,
		isDragging,
		swipePending,
		swipeBgOpacity,
		handlePointerDown,
		handlePointerMove,
		handlePointerUp,
		handlePointerCancel,
	} = useSwipeToMarkRead(handleMarkRead)

	const title = item.object?.title ?? 'Untitled'
	const objectType = item.object?.type

	return (
		// Outer wrapper holds the green swipe-reveal background; the card translates over it.
		<div
			ref={cardRef}
			data-testid="unread-thread-card"
			className="relative overflow-hidden rounded-lg"
		>
			{/* Green background revealed on swipe-right */}
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0 flex items-center gap-2 bg-status-active-bg px-5 text-xs font-medium text-status-active-text"
				style={{ opacity: isDragging ? swipeBgOpacity : 0 }}
			>
				<CheckIcon size={14} />
				Mark read
			</div>

			{/* biome-ignore lint/a11y/useKeyWithClickEvents: card click supplements inner buttons/links, which keyboard users tab to and activate directly */}
			<div
				className={cn(
					'relative rounded-lg border bg-card cursor-pointer touch-pan-y',
					isDragging
						? 'transition-none'
						: 'transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
					swipePending ? 'opacity-35' : 'transition-opacity duration-200',
					isActive
						? 'border-ring shadow-[0_0_0_1px_hsl(var(--ring))]'
						: 'border-border hover:shadow-sm',
				)}
				style={{ transform: `translateX(${dragOffset}px)` }}
				onClick={handleCardClick}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerCancel}
			>
				{/* Header: bet context pill + type badge + title | time + @you + unread.
				    Title cell takes the full row on mobile (basis-full) so a long title
				    gets room to breathe instead of squeezing the time/badge/button
				    cluster off-screen at 375px; collapses to a single inline cell at sm+. */}
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2.5 border-b border-border">
					<div className="flex min-w-0 basis-full items-center gap-1.5 sm:basis-auto sm:flex-1">
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
						<Link
							to="/$workspaceId/objects/$objectId"
							params={{ workspaceId, objectId }}
							className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
							title={title}
							onClick={(e) => e.stopPropagation()}
						>
							{title}
						</Link>
					</div>
					<div className="flex shrink-0 items-center gap-1.5">
						{item.latest_activity_at && (
							<RelativeTime
								date={item.latest_activity_at}
								className="text-xs font-mono tabular-nums text-muted-foreground"
							/>
						)}
						{item.mentioning_unread_count > 0 && (
							<span
								aria-label="Mentioned"
								title="You were @-mentioned in an unread comment"
								className="rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-foreground"
							>
								@you
							</span>
						)}
						<UnreadBadge count={item.unread_count} />
					</div>
				</div>

				{/* Thread — all messages inline, page scrolls naturally */}
				<div className="px-3 py-2.5">
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

				{/* Quick-reply chips — one-tap sends immediately with a toast */}
				<div className="flex gap-1.5 overflow-x-auto border-t border-border px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
					{QUICK_REPLY_CHIPS.map((chip) => (
						<button
							key={chip}
							type="button"
							className="shrink-0 whitespace-nowrap rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground hover:bg-accent hover:text-foreground active:bg-foreground active:text-background disabled:opacity-50"
							onClick={(e) => {
								e.stopPropagation()
								quickReply.mutate(
									{ entity_id: objectId, content: chip, parent_event_id: replyTarget },
									{
										onSuccess: () => {
											handleMarkRead()
											toast(`✓ Sent: "${chip}"`)
										},
									},
								)
							}}
							disabled={quickReply.isPending}
						>
							{chip}
						</button>
					))}
				</div>

				{/* Footer: Reply + Mark read */}
				<div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
					<Button
						size="sm"
						variant="outline"
						className={cn(
							'h-7 px-2 text-xs font-medium',
							isActive && 'bg-foreground text-background border-foreground hover:bg-foreground/90',
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
							handleMarkRead()
						}}
						disabled={markRead.isPending}
					>
						Mark as read
					</Button>
				</div>
			</div>
		</div>
	)
}

function NewDivider() {
	return (
		<div className="my-2 flex items-center gap-2" aria-label="Unread divider">
			<div className="h-px flex-1 bg-error" />
			<span className="text-xs font-medium text-error">New</span>
		</div>
	)
}
