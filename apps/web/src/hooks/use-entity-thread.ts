import { useEntityEvents } from '@/hooks/use-events'
import type { EventResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'

// Cards/items within this distance of the viewport start fetching their events, so
// the next one below the fold is ready by the time the user scrolls to it.
const PREFETCH_ROOT_MARGIN = '400px'

export interface CommentNode {
	root: EventResponse
	replies: EventResponse[]
}

export interface UseEntityThreadResult {
	containerRef: RefObject<HTMLDivElement | null>
	hasBeenVisible: boolean
	events: EventResponse[] | undefined
	nodes: CommentNode[]
	firstUnreadRootId: number | null
	firstUnreadEventId: number | null
	latestRootId: number | null
	latestEventId: number
}

// Builds the root/reply thread tree for an entity's comment events, gated behind
// an IntersectionObserver (via `containerRef`) so off-screen cards don't all fetch
// at once. Also locates the unread boundary by walking the flat timeline backward
// from the latest event, counting non-viewer comments until `unreadCount` is
// reached — the events query is capped at 50, so if the server's unread count
// exceeds what's loaded, the boundary falls back to the oldest loaded comment.
export function useEntityThread(
	workspaceId: string,
	objectId: string,
	unreadCount: number,
): UseEntityThreadResult {
	const containerRef = useRef<HTMLDivElement>(null)
	const [hasBeenVisible, setHasBeenVisible] = useState(false)
	useEffect(() => {
		if (hasBeenVisible) return
		const node = containerRef.current
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
			// the viewer. unreadCount anchors the boundary so the divider always
			// reflects the server's count even when the local event list is partial.
			const flat: { rootId: number; eventId: number; actorId: string }[] = []
			for (const node of built) {
				flat.push({ rootId: node.root.id, eventId: node.root.id, actorId: node.root.actorId })
				for (const reply of node.replies) {
					flat.push({ rootId: node.root.id, eventId: reply.id, actorId: reply.actorId })
				}
			}

			const targetCount = unreadCount
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
		}, [events, unreadCount, currentActorId])

	return {
		containerRef,
		hasBeenVisible,
		events,
		nodes,
		firstUnreadRootId,
		firstUnreadEventId,
		latestRootId,
		latestEventId,
	}
}
