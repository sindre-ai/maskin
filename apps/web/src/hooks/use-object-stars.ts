import { readStars, writeStars } from '@/lib/objects-stars'
import { useCallback, useEffect, useState } from 'react'

export interface ObjectStars {
	starredIds: Set<string>
	isStarred: (objectId: string) => boolean
	toggleStar: (objectId: string) => void
}

/** The workspace's starred-object set, kept in sync across every tab that has
 *  the app open (the `storage` event fires in the *other* tabs on write, so a
 *  star set in one is reflected in the rest without a reload). */
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
		return () => window.removeEventListener('storage', onStorage)
	}, [workspaceId])

	const toggleStar = useCallback(
		(objectId: string) => {
			setStarredIds((current) => {
				const next = new Set(current)
				if (next.has(objectId)) next.delete(objectId)
				else next.add(objectId)
				writeStars(workspaceId, next)
				return next
			})
		},
		[workspaceId],
	)

	const isStarred = useCallback((objectId: string) => starredIds.has(objectId), [starredIds])

	return { starredIds, isStarred, toggleStar }
}
