import { useSyncExternalStore } from 'react'

// Voice is temporarily unavailable after a 429 from POST /api/voice-sessions
// (vendor rate limit, or the workspace's daily minutes). Every Call button
// reads this so they disable together, with one tooltip, until the server's
// retry_after_seconds has passed. Module-level on purpose: the buttons live on
// different surfaces (agent rows, detail header, thread header) with no shared
// parent, and the state is per browser tab.

export const VOICE_UNAVAILABLE_TOOLTIP = 'Voice temporarily unavailable — try again in a moment.'

let unavailableUntil = 0
let expiryTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function emit() {
	for (const listener of listeners) listener()
}

export function markVoiceUnavailable(retryAfterSeconds: number): void {
	const seconds =
		Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds : 30
	unavailableUntil = Date.now() + seconds * 1000
	if (expiryTimer) clearTimeout(expiryTimer)
	// setTimeout caps at ~24.8 days; a daily-cap retry is at most 24h.
	expiryTimer = setTimeout(emit, seconds * 1000 + 50)
	emit()
}

export function isVoiceUnavailable(): boolean {
	return Date.now() < unavailableUntil
}

export function resetVoiceAvailability(): void {
	unavailableUntil = 0
	if (expiryTimer) clearTimeout(expiryTimer)
	expiryTimer = null
	emit()
}

function subscribe(listener: () => void) {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

export function useVoiceUnavailable(): boolean {
	return useSyncExternalStore(subscribe, isVoiceUnavailable, () => false)
}
