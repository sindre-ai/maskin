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

/**
 * Fired by the WS tool-proxy, once per tool invocation — success or refusal.
 * Property schema is frozen against the Voice v1 tech spec §Observability.
 * `error_code` is null (never undefined) on success so the property stays
 * queryable: PostHog drops undefined props but keeps explicit nulls.
 */
export const VOICE_TOOL_CALL_EVENT = 'voice_tool_call'
export const VOICE_TURN_COMPLETED_EVENT = 'voice_turn_completed'

export type VoiceToolCallProps = {
	voice_session_id: string
	tool_name: string
	success: boolean
	latency_ms: number
	error_code: string | null
	[key: string]: string | number | boolean | null | undefined | string[] | number[]
}

export type VoiceTurnCompletedProps = {
	voice_session_id: string
	turn_index: number
	user_audio_ms: number
	agent_audio_ms: number
	barge_in: boolean
	[key: string]: string | number | boolean | null | undefined | string[] | number[]
}

export async function captureVoiceToolCall(
	humanActorId: string,
	props: VoiceToolCallProps,
): Promise<void> {
	await capturePosthogEvent(VOICE_TOOL_CALL_EVENT, humanActorId, props)
}

export async function captureVoiceTurnCompleted(
	humanActorId: string,
	props: VoiceTurnCompletedProps,
): Promise<void> {
	await capturePosthogEvent(VOICE_TURN_COMPLETED_EVENT, humanActorId, props)
}

// PostHog event helpers for the [Voice v1 bet]
// (https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/16bd0042-ff3d-4056-839c-410b0cd6f06e).
//
// This file scaffolds the `voice_session_ended` event. The session-end
// hangup route + WS-drop grace + idle-timeout sweeper (all in this task's
// spec) invoke `trackVoiceSessionEnded` from their terminal paths in a
// follow-up commit — the backend surfaces those paths sit on top of
// Task 1's voice_sessions table + POST /api/voice-sessions route, which
// isn't merged yet, so this file lands first and the invocation lands
// second. Contract is fixed by the tech spec §Observability schema.

/** Terminal reason a voice session ended. Every code path that closes a
 *  session picks exactly one — the finite enum lets PostHog segment by cause
 *  without a free-text field. */
export type VoiceEndedReason =
	| 'user_hangup'
	| 'idle_timeout'
	| 'network_error'
	| 'vendor_error'
	| 'server_stop'

/** Vendor providing the realtime audio session. Only OpenAI Realtime today;
 *  the enum is here so a future v2 (ElevenLabs, another provider) doesn't
 *  break the segment split silently. */
export type VoiceVendor = 'openai_realtime'

export interface VoiceSessionEndedProps {
	voice_session_id: string
	agent_id: string
	agent_name: string
	workspace_id: string
	/** Populated when the call had a linked /chats conversation (Task 3
	 *  persistence). Null on opt-out workspaces or aborted sessions. */
	conversation_id: string | null
	model: string
	vendor: VoiceVendor
	duration_ms: number
	ended_reason: VoiceEndedReason
	input_audio_seconds: number
	output_audio_seconds: number
	total_cost_usd: number
	tool_calls_count: number
	turn_count: number
}

/**
 * Fire the `voice_session_ended` PostHog event.
 *
 * The event is attributed to `human_actor_id` (the workspace member on the
 * call) because that is the distinct id every other voice event under this
 * bet uses — pinning to one identity keeps a workspace-member's voice
 * activation funnel joinable across the start / turn / end lifecycle. Agent
 * identity is carried as a property (`agent_id`) so the same funnel can be
 * split per agent when needed.
 */
export async function trackVoiceSessionEnded(
	humanActorId: string,
	props: VoiceSessionEndedProps,
): Promise<void> {
	await capturePosthogEvent('voice_session_ended', humanActorId, {
		voice_session_id: props.voice_session_id,
		agent_id: props.agent_id,
		agent_name: props.agent_name,
		workspace_id: props.workspace_id,
		conversation_id: props.conversation_id,
		model: props.model,
		vendor: props.vendor,
		duration_ms: props.duration_ms,
		ended_reason: props.ended_reason,
		input_audio_seconds: props.input_audio_seconds,
		output_audio_seconds: props.output_audio_seconds,
		total_cost_usd: props.total_cost_usd,
		tool_calls_count: props.tool_calls_count,
		turn_count: props.turn_count,
	})
}
