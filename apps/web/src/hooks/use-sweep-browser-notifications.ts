import { api } from '@/lib/api'
import {
	closeShownNotifications,
	isWebPushSupported,
	pushTagsOf,
	staleNotifications,
} from '@/lib/web-push'
import { useEffect } from 'react'

// The notifications list API caps a page at 100.
const PAGE_SIZE = 100

/**
 * Closes this browser's notifications for things already handled, when the app regains focus:
 * anything shown for this workspace whose tag is no longer a pending notification. It catches
 * what was handled in another tab or on another device, where no click in this tab closed it.
 */
export function useSweepBrowserNotifications(workspaceId: string) {
	useEffect(() => {
		if (!isWebPushSupported()) return
		let running = false
		const sweep = async () => {
			if (running || document.visibilityState !== 'visible') return
			running = true
			try {
				const pending = await api.notifications.list(workspaceId, {
					status: 'pending',
					limit: String(PAGE_SIZE),
				})
				// A full page may hide more pending ones; closing on a partial list could drop a live card.
				if (pending.length >= PAGE_SIZE) return
				const pendingTags = new Set(pending.flatMap(pushTagsOf))
				await closeShownNotifications((shown) =>
					staleNotifications(shown, workspaceId, pendingTags),
				)
			} catch {
				// Best effort; the next focus tries again.
			} finally {
				running = false
			}
		}
		void sweep()
		window.addEventListener('focus', sweep)
		document.addEventListener('visibilitychange', sweep)
		return () => {
			window.removeEventListener('focus', sweep)
			document.removeEventListener('visibilitychange', sweep)
		}
	}, [workspaceId])
}
