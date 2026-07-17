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

export function __resetBackNavTrackerForTesting(): void {
	lastPopstateAt = Number.NEGATIVE_INFINITY
	initialised = false
}
