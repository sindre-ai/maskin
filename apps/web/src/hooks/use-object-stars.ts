import { readStars, subscribeToStars, writeStars } from '@/lib/objects-stars'
import { useCallback, useEffect, useState } from 'react'

export interface ObjectStars {
	starredIds: Set<string>
	isStarred: (objectId: string) => boolean
	toggleStar: (objectId: string) => void
}

/** The workspace's starred-object set, kept in sync across every consumer.
 *  Two sources feed it: `subscribeToStars` for writes made in *this* tab (the
 *  list row and the route each call this hook, and the route's copy drives the
 *  Starred filter and its count), and the `storage` event for writes made in
 *  another tab — that event deliberately does not fire in the writing tab, so
 *  neither channel alone is enough. */
export function useObjectStars(workspaceId: string): ObjectStars {
	const [starredIds, setStarredIds] = useState<Set<string>>(() => readStars(workspaceId))

	useEffect(() => {
		setStarredIds(readStars(workspaceId))
	}, [workspaceId])

	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			// `key === null` is a `localStorage.clear()` from another tab.
			if (event.key !== null && !event.key.endsWith(workspaceId)) return
			setStarredIds(readStars(workspaceId))
		}
		window.addEventListener('storage', onStorage)
		const unsubscribe = subscribeToStars((changedWorkspaceId) => {
			if (changedWorkspaceId !== workspaceId) return
			setStarredIds(readStars(workspaceId))
		})
		return () => {
			window.removeEventListener('storage', onStorage)
			unsubscribe()
		}
	}, [workspaceId])

	const toggleStar = useCallback(
		(objectId: string) => {
			// Read-modify-write off storage rather than off `starredIds`: the write
			// has to happen outside the state updater (it is a side effect, and
			// StrictMode double-invokes updaters), and storage is the shared truth
			// every other instance of this hook is about to be notified from.
			const next = readStars(workspaceId)
			if (next.has(objectId)) next.delete(objectId)
			else next.add(objectId)
			writeStars(workspaceId, next)
		},
		[workspaceId],
	)

	const isStarred = useCallback((objectId: string) => starredIds.has(objectId), [starredIds])

	return { starredIds, isStarred, toggleStar }
}
