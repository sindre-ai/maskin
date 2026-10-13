// While a secret sits in the composer's vault field, nothing the browser reports about
// itself may be able to carry it. Error payloads can include component state, input
// values and breadcrumbs, so the reporters check this before they send anything. A count
// rather than a flag, so two surfaces pausing at once do not un-pause each other.

let pauseCount = 0

/** Pauses client error reporting until the returned function is called. Safe to call it twice. */
export function pauseClientErrorLogging(): () => void {
	pauseCount++
	let released = false
	return () => {
		if (released) return
		released = true
		pauseCount--
	}
}

export function isClientErrorLoggingPaused(): boolean {
	return pauseCount > 0
}
