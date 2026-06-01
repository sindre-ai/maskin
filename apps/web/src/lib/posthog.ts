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

// Test-only — lets the analytics test suite simulate the post-init state.
export function __setInitializedForTesting(value: boolean): void {
	initialized = value
}
