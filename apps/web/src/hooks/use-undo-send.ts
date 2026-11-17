import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export const UNDO_SEND_FLAG = 'chat-undo-send'
export const UNDO_SEND_WINDOW_MS = 5000

export interface HeldSend {
	/** The real send. Runs once, when the window ends or the held message is flushed. */
	send: () => Promise<unknown>
	/**
	 * The send for a page that is going away (tab closed, app backgrounded): a request that
	 * outlives the page, with no cache updates, since nothing will be there to read them.
	 */
	sendOnHide: () => Promise<unknown>
	/** Puts the message back in the box: on Undo, and when a delayed send fails. */
	restore: () => void
	/** Reports a delayed send that failed, after the box was already cleared. */
	onError?: (err: unknown) => void
}

/**
 * Undo send. `hold` keeps a message in the client for `UNDO_SEND_WINDOW_MS` and posts nothing
 * until the window ends, so an undone message is never delivered, saved or seen by an agent.
 * Sending again, leaving the chat, closing the tab or sending the app to the background posts
 * the held message at once: it is never dropped and never reordered. With the flag off `hold` just runs `send`, and its
 * rejection reaches the caller as before.
 *
 * `scopeKey` is whatever the held message belongs to (the conversation): when it changes the
 * held message is posted first, while the old send function is still the live one.
 */
export function useUndoSend(scopeKey?: string) {
	const enabled = useFeatureFlag(UNDO_SEND_FLAG)
	const heldRef = useRef<HeldSend | null>(null)
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const chainRef = useRef<Promise<void>>(Promise.resolve())
	const [isHeld, setIsHeld] = useState(false)

	const take = useCallback(() => {
		if (timerRef.current) clearTimeout(timerRef.current)
		timerRef.current = null
		const held = heldRef.current
		heldRef.current = null
		setIsHeld(false)
		return held
	}, [])

	const flush = useCallback(() => {
		const held = take()
		if (!held) return
		// One send at a time, in the order they were held.
		chainRef.current = chainRef.current.then(() =>
			held.send().then(
				() => undefined,
				(err) => {
					held.restore()
					held.onError?.(err)
				},
			),
		)
	}, [take])

	// The page is going away: fire now, not behind an earlier send, and let the request outlive it.
	// A failure here has nobody left to tell.
	const flushOnHide = useCallback(() => {
		take()
			?.sendOnHide()
			.catch(() => undefined)
	}, [take])

	const hold = useCallback(
		async (next: HeldSend) => {
			if (!enabled) {
				await next.send()
				return
			}
			flush()
			heldRef.current = next
			setIsHeld(true)
			timerRef.current = setTimeout(flush, UNDO_SEND_WINDOW_MS)
		},
		[enabled, flush],
	)

	const undo = useCallback(() => {
		take()?.restore()
	}, [take])

	// biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the trigger, not a value the cleanup reads.
	useLayoutEffect(() => flush, [flush, scopeKey])
	useEffect(() => {
		const onVisibility = () => {
			if (document.visibilityState === 'hidden') flushOnHide()
		}
		window.addEventListener('pagehide', flushOnHide)
		document.addEventListener('visibilitychange', onVisibility)
		return () => {
			window.removeEventListener('pagehide', flushOnHide)
			document.removeEventListener('visibilitychange', onVisibility)
		}
	}, [flushOnHide])

	return { hold, undo, isHeld }
}
