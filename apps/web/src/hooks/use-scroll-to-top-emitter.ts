import { trackScrollToTop } from '@/lib/analytics'
import { useEffect, useRef } from 'react'

// The workspace layout marks its scroll container with `data-scroll-root` — the
// element that owns `overflow-auto` and receives real scroll events. `window`
// does not scroll on `/objects/<id>` pages.
const SCROLL_ROOT_ATTR = 'data-scroll-root'

// How close to the top counts as "scrolled to top". 80 px is ~2× the 44 px
// sticky header, chosen to absorb momentum overshoot and anchor lines without
// letting a partial scroll fire the event. Matches the Product Analyst
// signoff on the firing rule (2026-07-20).
const TOP_THRESHOLD_PX = 80

// A single upward gesture must emit once, not per scroll frame. Wait this long
// for scroll events to settle in the top zone before emitting — cancels the
// event if the user scrolls back away from the top in the meantime.
const SETTLE_MS = 250

// The trigger arms only after the user has scrolled at least this many viewport
// heights down. 1 matches the ship-metric spec ("scroll depth > 1 viewport").
const ARM_VIEWPORTS = 1

interface UseScrollToTopEmitterOptions {
	enabled: boolean
	// The object's `type` column — `'bet'` for now. Carried as `object_subtype`
	// on the emitted event so the schema stays forward-compatible for insight
	// and task pages without a rename.
	objectSubtype: string
	objectId: string
}

// Emits `scroll_to_top` once per completed downward-then-upward gesture inside
// the app scroll container. Debounces to one event per gesture: after emitting,
// the trigger re-arms only when the user has scrolled ≥ 1 viewport down from
// the current position again — so jitter at the top can't re-emit.
export function useScrollToTopEmitter({
	enabled,
	objectSubtype,
	objectId,
}: UseScrollToTopEmitterOptions): void {
	const stateRef = useRef({ armed: false, maxDepthPx: 0, armAtDepthPx: 0 })

	useEffect(() => {
		if (!enabled) return
		if (typeof document === 'undefined') return

		const root = document.querySelector<HTMLElement>(`[${SCROLL_ROOT_ATTR}]`)
		if (!root) return

		stateRef.current = { armed: false, maxDepthPx: 0, armAtDepthPx: 0 }

		let scheduled = false
		let disposed = false
		let settleTimer: ReturnType<typeof setTimeout> | undefined

		const clearSettleTimer = () => {
			if (settleTimer) {
				clearTimeout(settleTimer)
				settleTimer = undefined
			}
		}

		const emit = () => {
			if (disposed) return
			const state = stateRef.current
			const viewportHeight = root.clientHeight
			if (viewportHeight <= 0) return
			if (!state.armed) return
			if (root.scrollTop > TOP_THRESHOLD_PX) return
			const depth = state.maxDepthPx
			trackScrollToTop({
				entity_id: objectId,
				entity_type: 'object',
				object_subtype: objectSubtype,
				scroll_depth_at_start_px: Math.round(depth),
				viewports_scrolled: Math.round((depth / viewportHeight) * 10) / 10,
			})
			state.armed = false
			state.armAtDepthPx = root.scrollTop
			state.maxDepthPx = root.scrollTop
		}

		const handle = () => {
			scheduled = false
			if (disposed) return
			const state = stateRef.current
			const scrollTop = root.scrollTop
			const viewportHeight = root.clientHeight
			if (viewportHeight <= 0) return

			if (scrollTop > state.maxDepthPx) state.maxDepthPx = scrollTop

			if (!state.armed) {
				if (state.maxDepthPx - state.armAtDepthPx >= viewportHeight * ARM_VIEWPORTS) {
					state.armed = true
				}
			}

			if (state.armed && scrollTop <= TOP_THRESHOLD_PX) {
				clearSettleTimer()
				settleTimer = setTimeout(() => {
					settleTimer = undefined
					emit()
				}, SETTLE_MS)
			} else if (scrollTop > TOP_THRESHOLD_PX) {
				clearSettleTimer()
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
			clearSettleTimer()
			root.removeEventListener('scroll', onScroll)
		}
	}, [enabled, objectSubtype, objectId])
}
