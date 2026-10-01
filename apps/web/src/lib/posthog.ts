import posthog, { type CaptureOptions } from 'posthog-js'

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

// Always attempt posthog.capture — do not gate on the module-local `initialized`
// flag. posthog-js safely handles a capture() called before init (it queues the
// event and flushes on init), and gating on our own flag has been the source of
// silent event drops in production: if `initPosthog()` runs but the flag isn't
// yet visible to a caller in another module realm (HMR reload, dev-server race,
// lazy re-import), the event goes to `console.info` and never reaches PostHog.
// The `try/catch` still keeps analytics from breaking the UI.
export function capture(
	name: string,
	props: Record<string, unknown>,
	options?: CaptureOptions,
): void {
	try {
		// Only pass the third arg when set — passing an explicit `undefined`
		// keeps the arity visible to `toHaveBeenCalledWith` matchers in the
		// tests, breaking every capture spec that predates options support.
		if (options) {
			posthog.capture(name, props, options)
		} else {
			posthog.capture(name, props)
		}
	} catch (err) {
		console.error('[posthog] capture failed', name, err)
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

export interface IdentifiedPerson {
	name?: string | null
	email?: string | null
}

// Identify the actor for analytics, applying the workspace's anonymise pref.
// When anonymised, the distinct_id sent to PostHog is SHA-256(actor.id) so the
// raw actor id never leaves the browser; the Synthesizer's joins still resolve
// because they key off `actor_id` registered as a super property, not
// `$distinct_id` (per the bet's property-contract decision). The optional
// `person` name/email become PostHog person properties so people show up as
// themselves instead of an id — dropped when anonymised, for the same reason
// the id is hashed.
export async function identifyForWorkspace(
	actorId: string,
	anonymize: boolean,
	person?: IdentifiedPerson,
): Promise<void> {
	if (!initialized) return
	try {
		const distinctId = anonymize ? await hashDistinctId(actorId) : actorId
		const properties: Record<string, string> = {}
		if (!anonymize) {
			if (person?.email) properties.email = person.email
			if (person?.name) properties.name = person.name
		}
		// Only pass the second arg when there is something to set — keeps the
		// single-arg call shape the existing identify specs assert on.
		if (Object.keys(properties).length > 0) {
			posthog.identify(distinctId, properties)
		} else {
			posthog.identify(distinctId)
		}
	} catch {
		// Analytics must never break the UI.
	}
}

// Called on sign-out so the next person on this browser starts from a fresh
// anonymous id instead of inheriting the previous user's identity.
export function resetPosthogIdentity(): void {
	if (!initialized) return
	try {
		posthog.reset()
	} catch {
		// Analytics must never break the UI.
	}
}

// Test-only — lets the analytics test suite simulate the post-init state.
export function __setInitializedForTesting(value: boolean): void {
	initialized = value
}
