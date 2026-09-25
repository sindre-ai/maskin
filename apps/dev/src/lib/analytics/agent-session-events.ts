import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

interface AgentSessionStartedWithPromptProps {
	workspaceId: string
	sessionId: string
	agentId: string
	agentName: string
	systemPrompt: string
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
	/**
	 * The `triggers.type` of the trigger that dispatched this session —
	 * `'cron'`, `'event'`, or `'reminder'`. Present only for trigger-dispatched
	 * sessions; absent for comment-fallback, interactive, and API-created ones,
	 * where `triggerSource` carries the attribution instead. This is the
	 * cron-vs-event split G2 needs to segment the skill-load rate.
	 */
	triggerType?: string
	/**
	 * `triggers.id` of the dispatching trigger (the `sessions.trigger_id`
	 * column). Paired with `triggerType` so any session can be traced back to
	 * the exact trigger that fired it.
	 */
	triggerId?: string
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
			trigger_source: p.triggerSource,
			source_comment_event_id: p.sourceCommentEventId,
			trigger_type: p.triggerType,
			trigger_id: p.triggerId,
		})
	} catch (err) {
		logger.warn('Failed to emit agent_session_started_with_prompt', {
			sessionId: p.sessionId,
			error: String(err),
		})
	}
}
