import { useEffect } from 'react'

const APP_NAME = 'Maskin'
const FALLBACK_TITLE = 'Maskin Workspace'

/**
 * Sets the browser tab title to "<title> · Maskin". While `title` is empty
 * (data still loading) it falls back to the static index.html value, so the
 * tab is never blank. Restores the fallback on unmount unless another route
 * has already replaced the title.
 *
 * Call it from leaf routes only: effects run child-first, so a layout route
 * that also called it would overwrite its child's title.
 */
export function useDocumentTitle(title?: string | null) {
	useEffect(() => {
		const next = title ? `${title} · ${APP_NAME}` : FALLBACK_TITLE
		document.title = next
		return () => {
			// Only restore the fallback if the title is still ours: a destination route
			// that sets its own (login/signup via the route head option) may already
			// have replaced it by the time this cleanup runs.
			if (document.title === next) document.title = FALLBACK_TITLE
		}
	}, [title])
}
