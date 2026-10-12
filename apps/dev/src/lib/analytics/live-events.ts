import { capturePosthogEvent } from './posthog'

/**
 * PostHog events for Live mode. Distinct id is the calling human's actor id so a
 * call joins to the rest of that person's activity. Contract mirrors
 * `analytics/posthog.ts`: never throws, never blocks a call.
 */

type Props = Record<string, string | number | boolean | null | undefined | string[] | number[]>

export type LiveDeniedReason =
	| 'flag_off'
	| 'no_agent'
	| 'not_live_enabled'
	| 'no_credentials'
	| 'concurrent'
	| 'rate_limited'
	| 'plan_cap'

export type LiveEndedReason =
	| 'user_hangup'
	| 'network_error'
	| 'idle_timeout'
	| 'plan_cap'
	| 'server_stop'
	| 'error'

export const trackLiveSessionStarted = (humanActorId: string, props: Props) =>
	capturePosthogEvent('live_session_started', humanActorId, props)

export const trackLiveSessionDenied = (
	humanActorId: string,
	props: { agent_id: string | null; workspace_id: string | null; reason: LiveDeniedReason },
) => capturePosthogEvent('live_session_denied', humanActorId, props)

/** `ttft_ms`: stop-talking to first model token. `ttfa_ms`: to first audio byte sent. */
export const trackLiveTurnCompleted = (humanActorId: string, props: Props) =>
	capturePosthogEvent('live_turn_completed', humanActorId, props)

export const trackLiveToolCall = (humanActorId: string, props: Props) =>
	capturePosthogEvent('live_tool_call', humanActorId, props)

export const trackLiveSessionEnded = (humanActorId: string, props: Props) =>
	capturePosthogEvent('live_session_ended', humanActorId, props)
