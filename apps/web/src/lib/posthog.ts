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

// SHA-256 hash used when the workspace is anonymised. Returns the raw actor id
// when Web Crypto isn't available (legacy browsers, jsdom without `subtle`) so
// the caller still produces a usable distinct_id — better than silently
// dropping identification.
export async function hashDistinctId(value: string): Promise<string> {
	const subtle = globalThis.crypto?.subtle
	if (!subtle) return value
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

const DOCS_DISTINCT_ID_PARAM = 'ph_distinct_id'

// The docs Get-started page decorates outbound maskin.sindre.ai links with
// `?ph_distinct_id=<anon>`. Aliasing it to this browser's current distinct_id
// lets the TTFMCP funnel join `docs_get_started_entered` to the workspace-side
// `$mcp_tool_call` event on a single person, even when the actor later
// identifies via `identifyForWorkspace`.
export function inheritDistinctIdFromUrl(): void {
	if (typeof window === 'undefined') return
	try {
		const url = new URL(window.location.href)
		const docsId = url.searchParams.get(DOCS_DISTINCT_ID_PARAM)
		if (!docsId) return

		url.searchParams.delete(DOCS_DISTINCT_ID_PARAM)
		window.history.replaceState({}, '', url.pathname + url.search + url.hash)

		if (!initialized) return
		posthog.alias(docsId)
	} catch {
		// Analytics must never break the UI.
	}
}

// Test-only — lets the analytics test suite simulate the post-init state.
export function __setInitializedForTesting(value: boolean): void {
	initialized = value
}
