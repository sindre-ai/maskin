import { useEffect, useRef, useState } from 'react'

const SPAWN_PULSE_MS = 2200

// What the id points at: a chat message (`?msg=` on the chat route) or an
// object-page comment (`?comment=`). Same jump and highlight, different node.
const TARGETS = {
	message: { attribute: 'data-message-id', announcement: 'Jumped to message from origin.' },
	comment: { attribute: 'data-comment-id', announcement: 'Jumped to comment.' },
} as const

/**
 * Reads a message id (from `?msg=<id>` on the chat detail route), waits for
 * that message's DOM node to appear, then:
 * - scrolls it into view (respecting the `scroll-mt-[60px]` on the wrapper so
 *   the fixed thread header doesn't clip it),
 * - stamps `data-origin-spawn` for the persistent brand-bar spawn marker
 *   (styled in `app.css`), and
 * - stamps `data-origin-pulse` for the 2.2s ease-out brand-tinted highlight,
 *   cleared after `SPAWN_PULSE_MS` so nothing loops.
 *
 * `kind` picks the DOM attribute to look for: `message` (default) matches
 * `data-message-id`, `comment` matches `data-comment-id` on the object page.
 *
 * Returns an announcement string for the `<output>` (`role=status
 * aria-live=polite`) region above. Empty when there's nothing to jump to, so
 * a page render that isn't a deep-link stays silent.
 *
 * `dataTrigger` is a dependency-as-trigger — the hook does not read it,
 * but re-runs when it changes so the jump lands as soon as the target row
 * mounts on a cold deep-link into a long thread (the query data is what
 * changes to signal fresh rows). Pass whatever your data fetch returns.
 */
export function useOriginDeepLinkScroll({
	messageId,
	dataTrigger,
	kind = 'message',
}: {
	messageId: number | null
	dataTrigger: unknown
	kind?: keyof typeof TARGETS
}): string {
	const [announcement, setAnnouncement] = useState('')
	// Guard against re-firing on unrelated re-renders (SSE, live updates,
	// pagination) — the effect must run exactly once per (deep-link
	// navigation, message actually in the DOM) pair.
	const jumpedForRef = useRef<number | null>(null)

	// biome-ignore lint/correctness/useExhaustiveDependencies: `dataTrigger` is not read inside the effect body — it is a dependency-as-trigger so the effect re-runs when the message list mounts more rows and the target node appears in the DOM. Without it, the effect fires once before data arrives, the querySelector returns null, and the jump never happens on a cold deep-link into a long thread.
	useEffect(() => {
		if (messageId == null) {
			jumpedForRef.current = null
			return
		}
		if (jumpedForRef.current === messageId) return
		if (typeof document === 'undefined') return

		const selector = `[${TARGETS[kind].attribute}="${messageId}"]`
		const node = document.querySelector<HTMLElement>(selector)
		if (!node) return

		jumpedForRef.current = messageId
		// Persistent marker — stays until the user navigates away. Read from
		// the CSS in `app.css` (`[data-origin-spawn] { ...vertical --brand bar }`).
		node.dataset.originSpawn = 'true'
		// One-shot pulse — background transition applied via a keyframe
		// animation, cleaned up after the animation fires so nothing loops.
		node.dataset.originPulse = 'true'
		node.scrollIntoView({ behavior: 'smooth', block: 'start' })

		const sessionTitle = node.dataset.spawnSessionTitle
		setAnnouncement(
			sessionTitle && sessionTitle.length > 0
				? `${TARGETS[kind].announcement} Session "${sessionTitle}".`
				: TARGETS[kind].announcement,
		)

		const timer = window.setTimeout(() => {
			delete node.dataset.originPulse
		}, SPAWN_PULSE_MS)
		return () => window.clearTimeout(timer)
	}, [messageId, dataTrigger, kind])

	return announcement
}
