import { getStoredActor } from './auth'
import { capture, isPosthogReady } from './posthog'

export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>

export function trackEvent(name: string, props: AnalyticsProps = {}): void {
	try {
		if (isPosthogReady()) {
			capture(name, props)
			return
		}
		const actor = getStoredActor()
		const payload = {
			ts: new Date().toISOString(),
			name,
			actorId: actor?.id ?? null,
			...props,
		}
		console.info('[analytics]', payload)
	} catch {
		// Analytics must never break the UI.
	}
}
