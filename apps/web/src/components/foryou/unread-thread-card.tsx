import { ActivityComment } from '@/components/activity/activity-comment'
import { CommentInput } from '@/components/activity/comment-input'
import { RelativeTime } from '@/components/shared/relative-time'
import { TypeBadge } from '@/components/shared/type-badge'
import { UnreadBadge } from '@/components/shared/unread-badge'
import { Button } from '@/components/ui/button'
import { useEntityEvents } from '@/hooks/use-events'
import { useMarkRead } from '@/hooks/use-subscriptions'
import type { EventResponse, UnreadItem } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { Link } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface UnreadThreadCardProps {
	workspaceId: string
	item: UnreadItem
}

interface CommentNode {
	root: EventResponse
	replies: EventResponse[]
}

// Cards within this distance of the viewport start fetching their events, so
// the next card or two below the fold is ready by the time the user scrolls.
const PREFETCH_ROOT_MARGIN = '400px'

/**
 * Unread thread card: shows the comment thread for one subscribed object with
 * a red "New" divider directly above the first unread comment (Slack-style),
 * not above the whole thread the comment belongs to. CommentInput is pinned
 * below the scroll area and posts as a reply to the unread thread when one
 * exists, so the user's "Thanks!" lands inline instead of starting a new
 * top-level thread.
 *
 * Lazy-fetches per-entity events: `useEntityEvents` only fires once the card
 * is within PREFETCH_ROOT_MARGIN of the viewport, so a page with N unread
 * threads doesn't fan out into N parallel network requests on mount.
 *
 * On first load the scroll body is pinned to the bottom so the most recent
 * activity is visible (and older threads are reachable by scrolling up).
 * This fires once per card; new comments arriving via SSE never re-yank the
 * scroll position.
 *
 * Mark-read is explicit: it only fires when the user clicks "Mark as read" or
 * successfully posts a reply. Mounting the card does not advance the read
 * high-water-mark.
 */
export function UnreadThreadCard({ workspaceId, item }: UnreadThreadCardProps) {
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
			// is partial. Capture both the exact event the divider sits above
			// (drawn between read/unread comments inside a thread) and the
			// containing root (the reply target for the composer).
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
			// events query is capped at 50), the loop never hits targetCount and
			// no divider would be drawn. Anchor to the oldest non-viewer comment
			// in the loaded window so the divider still appears above visible
			// unread activity.
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
		// Prefer the server's latest_event_id (authoritative even when local
		// events are partial), and fall back to whatever we have loaded.
		const target = Math.max(item.latest_event_id ?? 0, latestEventId)
		if (target <= 0) return
		markRead.mutate({ entityType: item.entity_type, entityId: objectId, lastEventId: target })
	}, [markRead, item.entity_type, objectId, item.latest_event_id, latestEventId])

	// Pin the scroll body to the bottom on first render so the most recent
	// thread is visible at the bottom (Slack-style). Older threads sit above
	// and are reachable by scrolling up. Done manually instead of
	// `scrollIntoView` so the page scroll position never moves. Fires once
	// per card; later SSE-driven event arrivals never re-yank the position.
	const scrollBodyRef = useRef<HTMLDivElement>(null)
	const didScrollInitiallyRef = useRef(false)
	useEffect(() => {
		if (didScrollInitiallyRef.current) return
		if (nodes.length === 0) return
		const body = scrollBodyRef.current
		if (!body) return
		body.scrollTop = body.scrollHeight
		didScrollInitiallyRef.current = true
	}, [nodes.length])

	const title = item.object?.title ?? 'Untitled'
	const objectType = item.object?.type

	return (
		<div ref={cardRef} className="rounded-lg border border-border bg-card">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-3">
				{/* Title row: takes the full row on mobile so a long title gets room
				    to breathe; on sm+ collapses back to a single inline cell. */}
				<div className="flex min-w-0 basis-full items-center gap-2 sm:basis-auto sm:flex-1">
					{objectType && <TypeBadge type={objectType} />}
					<Link
						to="/$workspaceId/objects/$objectId"
						params={{ workspaceId, objectId }}
						className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
						title={title}
					>
						{title}
					</Link>
				</div>
				{item.latest_activity_at && (
					<RelativeTime
						date={item.latest_activity_at}
						className="shrink-0 text-xs text-muted-foreground"
					/>
				)}
				{item.mentioning_unread_count > 0 && (
					<span
						aria-label="Mentioned"
						title="You were @-mentioned in an unread comment"
						className="shrink-0 rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-foreground"
					>
						@you
					</span>
				)}
				<UnreadBadge count={item.unread_count} className="shrink-0" />
				<Button
					size="sm"
					variant="ghost"
					className="shrink-0 h-7 px-2 text-xs"
					onClick={handleMarkRead}
					disabled={markRead.isPending}
				>
					Mark as read
				</Button>
			</div>

			<div ref={scrollBodyRef} className="h-72 overflow-y-auto px-4 py-3 sm:h-96">
				{nodes.length === 0 ? (
					<p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
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

			<div className="border-t border-border px-4 py-3">
				<CommentInput
					workspaceId={workspaceId}
					objectId={objectId}
					parentEventId={firstUnreadRootId ?? latestRootId ?? undefined}
					onSubmitted={handleMarkRead}
				/>
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
