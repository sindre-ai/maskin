import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

interface AgentSessionStartedWithPromptProps {
	workspaceId: string
	sessionId: string
	agentId: string
	agentName: string
	systemPrompt: string
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
		})
	} catch (err) {
		logger.warn('Failed to emit agent_session_started_with_prompt', {
			sessionId: p.sessionId,
			error: String(err),
		})
	}
}
