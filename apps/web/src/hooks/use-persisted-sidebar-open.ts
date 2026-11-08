import { getStoredSidebarOpen, persistSidebarOpen } from '@/lib/nav-view-keys'
import { useCallback, useState } from 'react'

// One flag for the whole app: the sidebar is the same width on every page
// unless the person collapsed it, and then it stays collapsed everywhere. It
// used to be remembered per view, which left Agents and Marketplace as a 60px
// rail after a single collapse there while every other page was expanded. The
// key is the old For you key, so a person's existing choice there carries over.
const SIDEBAR_KEY = 'home'

export function usePersistedSidebarOpen() {
	const [open, setOpenState] = useState<boolean>(() => getStoredSidebarOpen(SIDEBAR_KEY))

	const setOpen = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
		setOpenState((prev) => {
			const next = typeof value === 'function' ? value(prev) : value
			persistSidebarOpen(SIDEBAR_KEY, next)
			return next
		})
	}, [])

	return { open, setOpen }
}
