import posthog from 'posthog-js'

const DEFAULT_HOST = 'https://eu.i.posthog.com'

let initialized = false

export function initPosthog(): void {
	if (initialized) return
	const key = import.meta.env.VITE_POSTHOG_KEY
	if (!key) return
	try {
		posthog.init(key, {
			api_host: import.meta.env.VITE_POSTHOG_HOST ?? DEFAULT_HOST,
			person_profiles: 'identified_only',
			capture_pageview: true,
			autocapture: false,
		})
		initialized = true
	} catch {
		// Analytics must never break the UI.
	}
}

export function isPosthogReady(): boolean {
	return initialized
}

export function capture(name: string, props: Record<string, unknown>): void {
	if (!initialized) return
	try {
		posthog.capture(name, props)
	} catch {
		// Analytics must never break the UI.
	}
}

export interface WorkspaceSuperProperties {
	workspace_id: string
	actor_id: string
	actor_type: string
}

// Pins the Synthesizer's join keys onto every subsequent capture call —
// see Magnus's property-contract addition to the bet's ADR.
export function registerWorkspaceProperties(props: WorkspaceSuperProperties): void {
	if (!initialized) return
	try {
		posthog.register(props)
	} catch {
		// Analytics must never break the UI.
	}
}

// Mirrors the Privacy & data toggle. When users turn share-usage off we
// route through PostHog's opt_out so the queued events never leave the
// browser; turning it back on flushes the standard opt_in path.
export function setCapturingEnabled(enabled: boolean): void {
	if (!initialized) return
	try {
		if (enabled) {
			posthog.opt_in_capturing()
		} else {
			posthog.opt_out_capturing()
		}
	} catch {
		// Analytics must never break the UI.
	}
}

// SHA-256 hash used when the workspace is anonymised. When Web Crypto is
// unavailable (non-HTTPS context, legacy jsdom) the distinct_id is sent
// unhashed — a known privacy tradeoff: Anonymize reads "on" in the UI but the
// raw actor id still leaves the browser. Production HTTPS always has crypto.subtle.
export async function hashDistinctId(value: string): Promise<string> {
	const subtle = globalThis.crypto?.subtle
	if (!subtle) {
		console.warn(
			'[analytics] Anonymize fallback: crypto.subtle unavailable, distinct_id sent unhashed',
		)
		return value
	}
	const bytes = new TextEncoder().encode(value)
	const digest = await subtle.digest('SHA-256', bytes)
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

// Identify the actor for analytics, applying the workspace's anonymise pref.
// When anonymised, the distinct_id sent to PostHog is SHA-256(actor.id) so the
// raw actor id never leaves the browser; the Synthesizer's joins still resolve
// because they key off `actor_id` registered as a super property, not
// `$distinct_id` (per the bet's property-contract decision).
export async function identifyForWorkspace(actorId: string, anonymize: boolean): Promise<void> {
	if (!initialized) return
	try {
		const distinctId = anonymize ? await hashDistinctId(actorId) : actorId
		posthog.identify(distinctId)
	} catch {
		// Analytics must never break the UI.
	}
}

// Test-only — lets the analytics test suite simulate the post-init state.
export function __setInitializedForTesting(value: boolean): void {
	initialized = value
}
