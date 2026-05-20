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
import { useCallback, useEffect, useMemo, useRef } from 'react'

interface UnreadThreadCardProps {
	workspaceId: string
	item: UnreadItem
}

interface CommentNode {
	root: EventResponse
	replies: EventResponse[]
}

/**
 * Slack-style unread thread card: fixed-height scroll body anchored to the
 * bottom on mount so the unread tail is visible by default. A "New" divider
 * sits before the first thread containing unread activity; scrolling up
 * reveals older threads on the same object. CommentInput is pinned below the
 * scroll area so the reply input is always reachable.
 *
 * Mark-read is explicit: it only fires when the user clicks "Mark as read" or
 * successfully posts a reply. Mounting the card does not advance the read
 * high-water-mark.
 */
export function UnreadThreadCard({ workspaceId, item }: UnreadThreadCardProps) {
	const objectId = item.entity_id
	const { data: events } = useEntityEvents(workspaceId, objectId)
	const currentActorId = getStoredActor()?.id ?? null

	const { nodes, firstUnreadRootId, latestEventId } = useMemo(() => {
		if (!events) {
			return {
				nodes: [] as CommentNode[],
				firstUnreadRootId: null as number | null,
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

		// Walk the *flat* timeline (root + replies in chronological order) from
		// the newest backward, counting comments that don't belong to the viewer.
		// item.unread_count anchors the boundary so the divider always reflects
		// the server's count, even when the local event list is partial. The
		// boundary attaches to the *thread* containing the oldest unread comment.
		const flat: { rootId: number; actorId: string }[] = []
		for (const node of built) {
			flat.push({ rootId: node.root.id, actorId: node.root.actorId })
			for (const reply of node.replies) {
				flat.push({ rootId: node.root.id, actorId: reply.actorId })
			}
		}

		const targetCount = item.unread_count
		let counted = 0
		let boundaryRootId: number | null = null
		for (let i = flat.length - 1; i >= 0 && counted < targetCount; i--) {
			const entry = flat[i]
			if (!entry) continue
			if (currentActorId && entry.actorId === currentActorId) continue
			counted++
			if (counted === targetCount) boundaryRootId = entry.rootId
		}

		return { nodes: built, firstUnreadRootId: boundaryRootId, latestEventId: maxId }
	}, [events, item.unread_count, currentActorId])

	const markRead = useMarkRead(workspaceId)
	const handleMarkRead = useCallback(() => {
		// Prefer the server's latest_event_id (authoritative even when local
		// events are partial), and fall back to whatever we have loaded.
		const target = Math.max(item.latest_event_id ?? 0, latestEventId)
		if (target <= 0) return
		markRead.mutate({ entityType: 'object', entityId: objectId, lastEventId: target })
	}, [markRead, objectId, item.latest_event_id, latestEventId])

	// Anchor the scroll body to the bottom on mount and whenever the newest
	// event id changes (new comment arrives via SSE invalidation). Older
	// threads stay off-screen above until the user scrolls up.
	const scrollRef = useRef<HTMLDivElement>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: latestEventId is the trigger; the effect only reads the ref.
	useEffect(() => {
		const node = scrollRef.current
		if (!node) return
		node.scrollTop = node.scrollHeight
	}, [latestEventId])

	const title = item.object?.title ?? 'Untitled'
	const objectType = item.object?.type
	const titlePath = `/${workspaceId}/objects/${objectId}`

	return (
		<div className="rounded-lg border border-border bg-card">
			<div className="flex items-center gap-2 border-b border-border px-4 py-3">
				{objectType && <TypeBadge type={objectType} />}
				<Link to={titlePath} className="text-sm font-medium truncate hover:underline" title={title}>
					{title}
				</Link>
				{item.latest_activity_at && (
					<RelativeTime
						date={item.latest_activity_at}
						className="text-xs text-muted-foreground ml-auto"
					/>
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

			<div ref={scrollRef} className="h-96 overflow-y-auto px-4 py-3">
				{nodes.length === 0 ? (
					<p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
				) : (
					<div className="space-y-1">
						{nodes.map((node) => (
							<div key={node.root.id}>
								{firstUnreadRootId === node.root.id && <NewDivider />}
								<ActivityComment
									event={node.root}
									replies={node.replies}
									workspaceId={workspaceId}
									objectId={objectId}
								/>
							</div>
						))}
					</div>
				)}
			</div>

			<div className="border-t border-border px-4 py-3">
				<CommentInput workspaceId={workspaceId} objectId={objectId} onSubmitted={handleMarkRead} />
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
