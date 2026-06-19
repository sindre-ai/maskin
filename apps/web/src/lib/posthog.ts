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

// Test-only — lets the analytics test suite simulate the post-init state.
export function __setInitializedForTesting(value: boolean): void {
	initialized = value
}

// Maskin Chat ship-metric events. These power the bet's weekly-active chat
// usage metric; T28 verifies they reach PostHog from the live surface.
// Surface-agnostic on purpose so the same emitter keeps firing when PR #720
// replaces sindre-chat with the multi-agent conversation surface.

export type ChatSurface = 'sheet' | 'pulse-bar'

export interface ChatSessionOpenedProps {
	workspace_id: string
	surface: ChatSurface
}

export interface ChatMessageSentProps {
	workspace_id: string
	surface: ChatSurface
	/** Null when the message is routed to the default Sindre session. */
	target_agent_id: string | null
	attached_objects: number
	attached_notifications: number
	attached_files: number
}

export interface ChatActiveUserSessionProps {
	workspace_id: string
}

const ACTIVE_USER_SESSION_DEBOUNCE_MS = 24 * 60 * 60 * 1000
const ACTIVE_USER_SESSION_STORAGE_PREFIX = 'maskin.posthog.chat_active_user_session'

function activeUserSessionStorageKey(workspaceId: string): string {
	return `${ACTIVE_USER_SESSION_STORAGE_PREFIX}.${workspaceId}`
}

export function trackChatSessionOpened(props: ChatSessionOpenedProps): void {
	capture('chat_session_opened', { ...props })
	trackChatActiveUserSession({ workspace_id: props.workspace_id })
}

export function trackChatMessageSent(props: ChatMessageSentProps): void {
	capture('chat_message_sent', { ...props })
	trackChatActiveUserSession({ workspace_id: props.workspace_id })
}

// Fires at most once per 24h per workspace per browser. Debounced via
// localStorage so a tab reload doesn't re-emit and PostHog's weekly-active
// count stays driven by real activity rather than refresh count.
export function trackChatActiveUserSession(props: ChatActiveUserSessionProps): void {
	if (!initialized) return
	if (typeof window === 'undefined') return
	try {
		const key = activeUserSessionStorageKey(props.workspace_id)
		const raw = window.localStorage.getItem(key)
		const last = raw === null ? 0 : Number.parseInt(raw, 10)
		const now = Date.now()
		if (Number.isFinite(last) && last > 0 && now - last < ACTIVE_USER_SESSION_DEBOUNCE_MS) {
			return
		}
		capture('chat_active_user_session', { ...props })
		window.localStorage.setItem(key, String(now))
	} catch {
		// Analytics must never break the UI.
	}
}

// Test-only — drops the persisted debounce timestamp so suites can replay the
// first-emit path.
export function __clearChatActiveUserSessionForTesting(workspaceId: string): void {
	if (typeof window === 'undefined') return
	try {
		window.localStorage.removeItem(activeUserSessionStorageKey(workspaceId))
	} catch {}
}
