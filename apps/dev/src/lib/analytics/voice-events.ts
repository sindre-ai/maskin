import { capturePosthogEvent } from './posthog'

/**
 * PostHog events fired by the Voice v1 session-mint route
 * (POST /api/voice-sessions).
 *
 * `voice_session_started` fires exactly once on the 201 path. Its distinct id
 * is the calling human's actor id so a session can be joined to that actor's
 * other PostHog activity. `voice_session_denied` fires on every non-201 mint
 * outcome — 400 / 404 / 409 / 429 — with the exact `reason` enum from the
 * tech spec, so a "how often does the voice-mode flag block a call vs. how
 * often does OpenAI 429 us" question is one PostHog filter, not a join.
 *
 * Contract mirrors `analytics/posthog.ts`: never throws, never blocks. A
 * PostHog outage does not fail a session mint.
 */

export const VOICE_SESSION_STARTED_EVENT = 'voice_session_started'
export const VOICE_SESSION_DENIED_EVENT = 'voice_session_denied'

export type VoiceSessionDeniedReason =
	| 'flag_off'
	| 'no_active_agent'
	| 'concurrent_active'
	| 'rate_limited'
	| 'mic_denied'

export type VoiceSessionStartedProps = {
	voice_session_id: string
	agent_id: string
	agent_name: string
	workspace_id: string
	conversation_id: string | null
	model: string
	vendor: string
	// PosthogEventProps allows a broader value shape; the extra index signature
	// keeps this type structurally compatible without loosening the required
	// keys above.
	[key: string]: string | number | boolean | null | undefined | string[] | number[]
}

export type VoiceSessionDeniedProps = {
	agent_id: string | null
	workspace_id: string | null
	reason: VoiceSessionDeniedReason
	[key: string]: string | number | boolean | null | undefined | string[] | number[]
}

export async function captureVoiceSessionStarted(
	humanActorId: string,
	props: VoiceSessionStartedProps,
): Promise<void> {
	await capturePosthogEvent(VOICE_SESSION_STARTED_EVENT, humanActorId, props)
}

export async function captureVoiceSessionDenied(
	humanActorId: string,
	props: VoiceSessionDeniedProps,
): Promise<void> {
	await capturePosthogEvent(VOICE_SESSION_DENIED_EVENT, humanActorId, props)
}
