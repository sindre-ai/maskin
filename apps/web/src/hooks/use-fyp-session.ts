import {
	trackFypOpenedFirst,
	trackFypSessionOpened,
	trackWorkspaceSessionStart,
} from '@/lib/analytics'
import { useEffect } from 'react'

const WSS_KEY = 'maskin_fyp_wss_fired'
const FYP_OPENED_FIRST_KEY = 'maskin_fyp_opened_first_fired'
const FYP_SESSION_OPENED_KEY = 'maskin_fyp_session_opened_fired'

function readFlag(key: string): boolean {
	try {
		return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(key) === '1'
	} catch {
		return false
	}
}

function writeFlag(key: string): void {
	try {
		sessionStorage?.setItem(key, '1')
	} catch {}
}

// True when `pathname` is the workspace root — the For You feed lives on
// `/$workspaceId`. Nested routes (`/$workspaceId/objects`, object detail,
// settings) are not For You.
export function isForYouEntryPath(pathname: string, workspaceId: string): boolean {
	const normalized = pathname.replace(/\/+$/, '')
	return normalized === `/${workspaceId}`
}

// Fires on WorkspaceLayout mount. `workspace_session_start` is the tab-session
// denominator for the For-You-first rate; `fyp_opened_first` is its numerator
// and fires only when the URL at first mount is the For You feed — a later
// client-side navigation to For You is a different case and does not count.
// Both are guarded by sessionStorage so they fire at most once per tab.
export function useFypWorkspaceMountEvents(workspaceId: string): void {
	useEffect(() => {
		if (!workspaceId) return

		const isFirstMount = !readFlag(WSS_KEY)
		if (isFirstMount) {
			writeFlag(WSS_KEY)
			trackWorkspaceSessionStart({ workspace_id: workspaceId })
		}

		if (isFirstMount && !readFlag(FYP_OPENED_FIRST_KEY)) {
			const pathname = typeof window === 'undefined' ? '' : window.location.pathname
			if (isForYouEntryPath(pathname, workspaceId)) {
				writeFlag(FYP_OPENED_FIRST_KEY)
				trackFypOpenedFirst({ workspace_id: workspaceId })
			}
		}
	}, [workspaceId])
}

// Fires on ForYouDashboard mount. `fyp_session_opened` is the denominator for
// briefing engagement and fires once per tab session on the first arrival at
// the For You feed, whether that's the entry surface or a later navigation.
// Later re-mounts (leaving and coming back) do not re-fire.
export function useFypSessionOpenedEvent(workspaceId: string): void {
	useEffect(() => {
		if (!workspaceId) return
		if (readFlag(FYP_SESSION_OPENED_KEY)) return
		writeFlag(FYP_SESSION_OPENED_KEY)
		trackFypSessionOpened({ workspace_id: workspaceId })
	}, [workspaceId])
}
