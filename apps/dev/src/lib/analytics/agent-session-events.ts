import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

interface AgentSessionStartedWithPromptProps {
	workspaceId: string
	sessionId: string
	agentId: string
	agentName: string
	systemPrompt: string
	/**
	 * `sessions.sourceSessionId` — non-null when the session was spawned by
	 * another session (sub-agent delegation). Ridden onto every emission as
	 * `source_session_id` so PostHog can isolate spawn events from top-level
	 * starts with `WHERE source_session_id IS NOT NULL`.
	 */
	sourceSessionId?: string | null
	/**
	 * Names the dispatch path that spawned this session. Present for sessions
	 * spawned by the comment-fallback resolver (`'comment_fallback'`) so
	 * PostHog queries can attribute a session to comment→dispatch vs. cron,
	 * event triggers, etc. Absent for every other path.
	 */
	triggerSource?: string
	/**
	 * `events.id` of the `commented` row that caused this session. Paired with
	 * `triggerSource` so a resolved comment can be traced end-to-end from
	 * comment → notification → session.
	 */
	sourceCommentEventId?: number
}

/**
 * Cheap tokens-from-chars approximation (Anthropic's documented ~4-chars-per-token
 * rule of thumb). Sufficient for measuring *relative* per-agent preamble drops;
 * we ship raw char count alongside so downstream queries can sanity-check.
 */
export function approximatePromptTokens(text: string): number {
	if (text.length === 0) return 0
	return Math.ceil(text.length / 4)
}

/**
 * Fires `agent_session_started_with_prompt` once per session launch (initial
 * start or resume). Carries the agent's identity and the size of its
 * `systemPrompt` at launch, so PostHog can plot mean preamble tokens per agent
 * over time — the missing measurement gate for the "simplify agent prompts"
 * bet.
 *
 * Best-effort: any PostHog failure is swallowed so analytics can never block a
 * session launch.
 */
export async function trackAgentSessionStartedWithPrompt(
	p: AgentSessionStartedWithPromptProps,
): Promise<void> {
	try {
		const chars = p.systemPrompt.length
		const tokens = approximatePromptTokens(p.systemPrompt)
		await capturePosthogEvent('agent_session_started_with_prompt', p.agentId, {
			workspace_id: p.workspaceId,
			session_id: p.sessionId,
			agent_id: p.agentId,
			agent_name: p.agentName,
			system_prompt_chars: chars,
			system_prompt_tokens: tokens,
			source_session_id: p.sourceSessionId ?? null,
			trigger_source: p.triggerSource,
			source_comment_event_id: p.sourceCommentEventId,
		})
	} catch (err) {
		logger.warn('Failed to emit agent_session_started_with_prompt', {
			sessionId: p.sessionId,
			error: String(err),
		})
	}
}

interface AgentSessionCompletedProps {
	workspaceId: string
	sessionId: string
	actorId: string
	outcome: 'completed' | 'failed' | 'timeout'
}

/**
 * Environment flag gating the runtime-side `agent_session_completed` emission.
 * Default OFF at merge; the aggregate-review task decides when the pipeline
 * team flips it in prod so PostHog can re-baseline the merged/deduped stream
 * ahead of UI ship (see the bet spec's Instrumentation section).
 */
const RUNTIME_AGENT_SESSION_COMPLETED_FLAG = 'RUNTIME_AGENT_SESSION_COMPLETED_ENABLED'

export function isRuntimeAgentSessionCompletedEnabled(): boolean {
	const raw = process.env[RUNTIME_AGENT_SESSION_COMPLETED_FLAG]?.trim().toLowerCase()
	return raw === '1' || raw === 'true'
}

/**
 * Runtime mirror of the frontend `agent_session_completed` event
 * (`apps/web/src/lib/sse-invalidation.ts:83`). Fires from the session-manager
 * path when a session transitions to `completed`, `failed`, or `timeout`, so
 * unwatched sub-agents emit a completion even when no browser tab is on their
 * conversation SSE. The frontend event stays in place — HogQL dedupes the
 * merged stream on `entity_id` with prefer-runtime tiebreak.
 *
 * Gated by env var {@link RUNTIME_AGENT_SESSION_COMPLETED_FLAG}. Default OFF at
 * merge; call sites always call this helper so no code path knows about the
 * gate.
 *
 * Best-effort: any PostHog failure is swallowed so the completion path is
 * never blocked.
 */
export async function trackAgentSessionCompleted(p: AgentSessionCompletedProps): Promise<void> {
	if (!isRuntimeAgentSessionCompletedEnabled()) return
	try {
		await capturePosthogEvent('agent_session_completed', p.actorId, {
			// Mirror the frontend event's payload shape (see fillBase in
			// apps/web/src/lib/analytics.ts). `entity_id`/`entity_type`/`source`/
			// `flow_id`/`outcome` match by name, casing and type; `source` is
			// the discriminator HogQL keys off for the prefer-runtime tiebreak.
			entity_id: p.sessionId,
			entity_type: 'session',
			source: 'runtime',
			flow_id: null,
			outcome: p.outcome,
			// The frontend registers workspace_id + actor_id as PostHog super
			// properties on workspace mount so they ride every event; the
			// runtime has no super-property layer, so include them explicitly.
			workspace_id: p.workspaceId,
			actor_id: p.actorId,
		})
	} catch (err) {
		logger.warn('Failed to emit agent_session_completed', {
			sessionId: p.sessionId,
			error: String(err),
		})
	}
}
