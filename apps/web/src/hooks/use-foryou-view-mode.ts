import * as React from 'react'

export const FORYOU_VIEW_MODE_COOKIE_NAME = 'foryou_view_mode'
export const FORYOU_VIEW_MODE_COOKIE_MAX_AGE = 60 * 60 * 24 * 7

export type ForYouViewMode = 'card' | 'list'

const DEFAULT_MODE: ForYouViewMode = 'card'

function readCookie(): ForYouViewMode {
	if (typeof document === 'undefined') return DEFAULT_MODE
	const match = document.cookie
		.split('; ')
		.find((row) => row.startsWith(`${FORYOU_VIEW_MODE_COOKIE_NAME}=`))
	if (!match) return DEFAULT_MODE
	const value = match.slice(FORYOU_VIEW_MODE_COOKIE_NAME.length + 1)
	return value === 'list' ? 'list' : 'card'
}

export function useForYouViewMode(): {
	mode: ForYouViewMode
	setMode: (mode: ForYouViewMode) => void
} {
	const [mode, setModeState] = React.useState<ForYouViewMode>(readCookie)

	const setMode = React.useCallback((next: ForYouViewMode) => {
		if (typeof document !== 'undefined') {
			document.cookie = `${FORYOU_VIEW_MODE_COOKIE_NAME}=${next}; path=/; max-age=${FORYOU_VIEW_MODE_COOKIE_MAX_AGE}`
		}
		setModeState(next)
	}, [])

	return { mode, setMode }
}
