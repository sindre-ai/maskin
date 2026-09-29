/**
 * Voice v1 PostHog event helpers. The two events are shape-frozen against the
 * Voice v1 tech spec §Observability — call sites pass a typed payload and this
 * module fills in only the event name, so the property contract can't drift.
 * Super properties (`workspace_id`, `actor_id`, `actor_type`) are registered
 * once per workspace mount (see `lib/posthog.ts`) and travel on every capture,
 * so voice calls only supply the per-event fields.
 */

import { trackEvent } from './analytics'

export interface VoiceToolCallProps {
	voice_session_id: string
	tool_name: string
	success: boolean
	latency_ms: number
	error_code?: string | null
}

export interface VoiceTurnCompletedProps {
	voice_session_id: string
	turn_index: number
	user_audio_ms: number
	agent_audio_ms: number
	barge_in: boolean
}

export function trackVoiceToolCall(p: VoiceToolCallProps): void {
	trackEvent('voice_tool_call', {
		voice_session_id: p.voice_session_id,
		tool_name: p.tool_name,
		success: p.success,
		latency_ms: p.latency_ms,
		error_code: p.error_code ?? null,
	})
}

export function trackVoiceTurnCompleted(p: VoiceTurnCompletedProps): void {
	trackEvent('voice_turn_completed', {
		voice_session_id: p.voice_session_id,
		turn_index: p.turn_index,
		user_audio_ms: p.user_audio_ms,
		agent_audio_ms: p.agent_audio_ms,
		barge_in: p.barge_in,
	})
}
