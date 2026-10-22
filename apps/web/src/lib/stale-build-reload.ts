// Reloads the page once when a lazily loaded file from an older release is
// gone. Every deploy renames the hashed files under /assets, so a tab opened
// before the deploy still asks for the old names and gets a 404. Vite reports
// that as a `vite:preloadError` event; reloading picks up the new index.html.
//
// Guarded by a timestamp in sessionStorage so a genuinely missing file (or an
// offline network) shows the normal error instead of reloading in a loop.

const STORAGE_KEY = 'maskin-stale-build-reload-at'
const RELOAD_COOLDOWN_MS = 10_000

let initialised = false

export function shouldReloadForStaleBuild(now: number = Date.now()): boolean {
	try {
		const last = Number(sessionStorage.getItem(STORAGE_KEY))
		if (last && now - last < RELOAD_COOLDOWN_MS) return false
		sessionStorage.setItem(STORAGE_KEY, String(now))
		return true
	} catch {
		// Storage blocked: without a loop guard, don't reload at all.
		return false
	}
}

export function initStaleBuildReload(): void {
	if (initialised) return
	if (typeof window === 'undefined') return
	window.addEventListener('vite:preloadError', (event) => {
		if (!shouldReloadForStaleBuild()) return
		// Stop Vite rethrowing, so the failed import doesn't flash an error first.
		event.preventDefault()
		window.location.reload()
	})
	initialised = true
}
