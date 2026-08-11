import { getStoredSidebarOpen, persistSidebarOpen } from '@/lib/nav-view-keys'
import { useCallback, useEffect, useState } from 'react'

/**
 * Owns the sidebar open/collapsed state for one view (identified by a
 * `viewKey` from `nav-view-keys`). State is read from localStorage on first
 * mount, reset when the view changes, and written back on every change so
 * each view remembers its own collapse state across navigation and reload.
 */
export function usePersistedSidebarOpen(viewKey: string | null) {
	const effectiveKey = viewKey ?? 'home'
	const [open, setOpenState] = useState<boolean>(() => getStoredSidebarOpen(effectiveKey))

	// Reset when the view changes so each view starts from its own collapsed state.
	useEffect(() => {
		setOpenState(getStoredSidebarOpen(viewKey ?? 'home'))
	}, [viewKey])

	const setOpen = useCallback(
		(value: boolean | ((prev: boolean) => boolean)) => {
			setOpenState((prev) => {
				const next = typeof value === 'function' ? value(prev) : value
				persistSidebarOpen(viewKey ?? 'home', next)
				return next
			})
		},
		[viewKey],
	)

	return { open, setOpen }
}
