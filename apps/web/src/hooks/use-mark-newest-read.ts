import { useEffect, useRef, useState } from 'react'

const MAX_RETRY_DELAY_MS = 30_000

/**
 * Marks the newest message of an open thread as read. `newestId` is the id to
 * mark, or null when there is nothing to mark. Each id is attempted once at a
 * time, but a failed call is retried with backoff until the server confirms,
 * and a newer id marks again straight away.
 *
 * An id that was already marked is never re-marked, so a deliberate "mark as
 * unread" on the open thread is not flipped back to read.
 */
export function useMarkNewestRead(
	newestId: number | null,
	markRead: (messageId: number) => Promise<unknown>,
) {
	const markReadRef = useRef(markRead)
	markReadRef.current = markRead
	const lastMarkedRef = useRef<number | null>(null)
	const attemptsRef = useRef(0)
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	// Bumped after a failed call so the effect below runs again for the same id.
	const [retry, setRetry] = useState(0)

	useEffect(() => () => clearTimeout(timerRef.current), [])

	// biome-ignore lint/correctness/useExhaustiveDependencies: retry only exists to re-run this effect after a failed attempt
	useEffect(() => {
		if (newestId === null || lastMarkedRef.current === newestId) return
		lastMarkedRef.current = newestId
		markReadRef
			.current(newestId)
			.then(() => {
				attemptsRef.current = 0
			})
			.catch(() => {
				if (lastMarkedRef.current === newestId) lastMarkedRef.current = null
				const delay = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** attemptsRef.current)
				attemptsRef.current += 1
				clearTimeout(timerRef.current)
				timerRef.current = setTimeout(() => setRetry((n) => n + 1), delay)
			})
	}, [newestId, retry])
}
