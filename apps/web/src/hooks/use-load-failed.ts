import { useEffect, useState } from 'react'

/** How long a call may stay unanswered before its block says so. Cloudflare gives up at 100 s. */
export const GIVE_UP_AFTER_MS = 30_000

interface LoadState {
	data?: unknown
	isLoading?: boolean
	isError?: boolean
}

/**
 * True when a query has nothing to show and either failed or has been waiting longer than
 * `giveUpAfterMs`. The wait counts retries, so a slow API surfaces as a message after ~30 s
 * instead of a blank block for as long as the retries run. The request is left running: if
 * the answer arrives later, `data` fills in and this turns false again.
 */
export function useLoadFailed(query: LoadState, giveUpAfterMs = GIVE_UP_AFTER_MS): boolean {
	const noData = query.data === undefined
	const waiting = noData && query.isLoading === true
	const [gaveUp, setGaveUp] = useState(false)

	useEffect(() => {
		if (!waiting) {
			setGaveUp(false)
			return
		}
		const timer = window.setTimeout(() => setGaveUp(true), giveUpAfterMs)
		return () => window.clearTimeout(timer)
	}, [waiting, giveUpAfterMs])

	return noData && (query.isError === true || gaveUp)
}
