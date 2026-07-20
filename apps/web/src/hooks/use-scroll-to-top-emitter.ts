import { trackScrollToTop } from '@/lib/analytics'
import { useEffect, useRef } from 'react'

// The workspace layout marks its scroll container with `data-scroll-root` — the
// element that owns `overflow-auto` and receives real scroll events. `window`
// does not scroll on `/objects/<id>` pages.
const SCROLL_ROOT_ATTR = 'data-scroll-root'

// How close to the top counts as "scrolled to top". 24 px absorbs anchor lines
// and momentum overshoot without letting a partial scroll fire the event.
const TOP_THRESHOLD_PX = 24

// The trigger arms only after the user has scrolled at least this many viewport
// heights down. 1 matches the ship-metric spec ("scroll depth > 1 viewport").
const ARM_VIEWPORTS = 1

interface UseScrollToTopEmitterOptions {
	enabled: boolean
	objectType: string
	objectId: string
}

// Emits `scroll_to_top` once per completed downward-then-upward gesture inside
// the app scroll container. Debounces to one event per gesture: after emitting,
// the trigger re-arms only when the user has scrolled ≥ 1 viewport down again.
export function useScrollToTopEmitter({
	enabled,
	objectType,
	objectId,
}: UseScrollToTopEmitterOptions): void {
	const stateRef = useRef({ armed: false, maxDepthPx: 0 })

	useEffect(() => {
		if (!enabled) return
		if (typeof document === 'undefined') return

		const root = document.querySelector<HTMLElement>(`[${SCROLL_ROOT_ATTR}]`)
		if (!root) return

		stateRef.current = { armed: false, maxDepthPx: 0 }

		let scheduled = false
		let disposed = false

		const handle = () => {
			scheduled = false
			if (disposed) return
			const state = stateRef.current
			const scrollTop = root.scrollTop
			const viewportHeight = root.clientHeight
			if (viewportHeight <= 0) return

			if (scrollTop > state.maxDepthPx) {
				state.maxDepthPx = scrollTop
			}

			if (!state.armed && state.maxDepthPx >= viewportHeight * ARM_VIEWPORTS) {
				state.armed = true
			}

			if (state.armed && scrollTop <= TOP_THRESHOLD_PX) {
				const depth = state.maxDepthPx
				trackScrollToTop({
					object_type: objectType,
					object_id: objectId,
					scroll_depth_at_start_px: Math.round(depth),
					viewports_scrolled: Math.round((depth / viewportHeight) * 10) / 10,
				})
				state.armed = false
				state.maxDepthPx = scrollTop
			}
		}

		const onScroll = () => {
			if (scheduled) return
			scheduled = true
			requestAnimationFrame(handle)
		}

		root.addEventListener('scroll', onScroll, { passive: true })
		return () => {
			disposed = true
			root.removeEventListener('scroll', onScroll)
		}
	}, [enabled, objectType, objectId])
}
