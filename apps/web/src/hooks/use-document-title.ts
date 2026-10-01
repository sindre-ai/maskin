import { useEffect } from 'react'

const APP_NAME = 'Maskin'
const FALLBACK_TITLE = 'Maskin Workspace'

/**
 * Sets the browser tab title to "<title> · Maskin". While `title` is empty
 * (data still loading) it falls back to the static index.html value, so the
 * tab is never blank. Restores the fallback on unmount.
 *
 * Call it from leaf routes only: effects run child-first, so a layout route
 * that also called it would overwrite its child's title.
 */
export function useDocumentTitle(title?: string | null) {
	useEffect(() => {
		document.title = title ? `${title} · ${APP_NAME}` : FALLBACK_TITLE
		return () => {
			document.title = FALLBACK_TITLE
		}
	}, [title])
}
