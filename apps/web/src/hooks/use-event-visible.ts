import { useEffect, useRef } from 'react'

/**
 * Fires `onVisible(eventId)` the first time the referenced element scrolls into
 * view. Used to advance a page-level high-water-mark of "seen" comment ids so
 * we can mark an object read after the user actually scrolls past the new
 * activity (rather than the moment the page mounts).
 *
 * Entity-agnostic: the consumer chooses what to do with the id.
 */
export function useEventVisible(
	eventId: number,
	onVisible: (eventId: number) => void,
): React.RefObject<HTMLDivElement | null> {
	const ref = useRef<HTMLDivElement>(null)
	const firedRef = useRef(false)

	useEffect(() => {
		const node = ref.current
		if (!node) return
		if (firedRef.current) return

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting && !firedRef.current) {
						firedRef.current = true
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
