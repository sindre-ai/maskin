import { useEffect, useRef } from 'react'

/**
 * Fires `onVisible(eventId)` once per distinct `eventId` whenever the referenced
 * element is in view. Used to advance a page-level high-water-mark of "seen"
 * comment ids so we can mark an object read after the user scrolls past new
 * activity (rather than the moment the page mounts).
 *
 * Re-arms whenever `eventId` changes — important because new comments arriving
 * via SSE bump `eventId`, and the user scrolling past the sentinel again should
 * advance the HWM to the latest id.
 *
 * Entity-agnostic: the consumer chooses what to do with the id.
 */
export function useEventVisible(
	eventId: number,
	onVisible: (eventId: number) => void,
): React.RefObject<HTMLDivElement | null> {
	const ref = useRef<HTMLDivElement>(null)
	const firedForRef = useRef<number | null>(null)

	useEffect(() => {
		const node = ref.current
		if (!node) return
		if (firedForRef.current === eventId) return

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting && firedForRef.current !== eventId) {
						firedForRef.current = eventId
						onVisible(eventId)
						observer.disconnect()
					}
				}
			},
			{ threshold: 0.5 },
		)
		observer.observe(node)
		return () => observer.disconnect()
	}, [eventId, onVisible])

	return ref
}
