// Records the last time a browser back/forward navigation fired, so downstream
// mount effects can distinguish a POP landing (browser back/forward) from a
// PUSH/REPLACE landing (Link click, URL bar, hard refresh). `popstate` fires
// exactly for those two nav types and never for `Link`-driven pushState.
//
// Must be initialised at app boot (see `main.tsx`) rather than on the objects
// route module — a user who deep-links to `/objects/{id}` first and then hits
// browser back to the list would otherwise fire popstate before the objects
// route module loads, and the back-nav landing would go uncounted.
//
// The sentinel is `Number.NEGATIVE_INFINITY` (not `0`) because a warm/cached
// hard-refresh can hand out very small `performance.now()` values, and
// `performance.now() - 0 < 100` would fire a false-positive back-nav event on
// what was really a URL-bar landing — biasing the bet's denominator.

let lastPopstateAt = Number.NEGATIVE_INFINITY
let initialised = false
let firstArrivalConsumed = false

const WINDOW_MS = 100

export function initBackNavTracker(): void {
	if (initialised) return
	if (typeof window === 'undefined') return
	window.addEventListener('popstate', () => {
		lastPopstateAt = performance.now()
	})
	initialised = true
}

export function wasRecentBackNav(): boolean {
	return performance.now() - lastPopstateAt < WINDOW_MS
}

// Returns the nav_type for the current mount and marks the first-arrival slot
// consumed so subsequent SPA navigations don't look like `direct`.
//
// - `back` — a popstate fired within the last 100 ms (browser back/forward, or
//   a back-forward navigation that landed at the initial page load).
// - `direct` — this is the first arrival in the SPA session AND the initial
//   `PerformanceNavigationTiming.type` was `navigate` or `reload` (URL-bar
//   entry or hard refresh).
// - `link` — anything else, i.e. an in-app SPA navigation via `<Link>` /
//   `router.navigate` that doesn't fire popstate.
export function consumeArrivalNavType(): 'back' | 'direct' | 'link' {
	if (wasRecentBackNav()) return 'back'
	if (!firstArrivalConsumed) {
		firstArrivalConsumed = true
		const entry =
			typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
				? (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)
				: undefined
		if (entry?.type === 'back_forward') return 'back'
		return 'direct'
	}
	return 'link'
}

export function __resetBackNavTrackerForTesting(): void {
	lastPopstateAt = Number.NEGATIVE_INFINITY
	initialised = false
	firstArrivalConsumed = false
}
