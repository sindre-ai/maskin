import { useEffect } from 'react'

// Session-wide de-dup so the event fires exactly once per unique surface even
// when the row is unmounted and remounted (virtualized lists, scroll-in /
// scroll-out). Cleared only on full page reload — that matches the coverage
// proxy's "was this ever seen this session" semantic.
const seen = new Set<string>()

export interface TrackFirstRenderOptions {
	key: string | null | undefined
	eventName: string
	// Called at most once per unique (eventName, key) this session. Callers pass
	// a closure that invokes the typed analytics helper for the event — routing
	// the runtime call through the taxonomy so a prop-name drift on the wire
	// path is caught by the helper's type contract, not silently shipped.
	fire: () => void
	enabled?: boolean
}

export function useTrackFirstRender({
	key,
	eventName,
	fire,
	enabled = true,
}: TrackFirstRenderOptions): void {
	// biome-ignore lint/correctness/useExhaustiveDependencies: capture the fire closure at the moment key/enabled cross the fire threshold — later per-render mutations of the same-keyed row must not re-fire
	useEffect(() => {
		if (!enabled) return
		if (!key) return
		const dedupKey = `${eventName}:${key}`
		if (seen.has(dedupKey)) return
		seen.add(dedupKey)
		fire()
	}, [key, eventName, enabled])
}

export function __resetFirstRenderTrackerForTesting(): void {
	seen.clear()
}
