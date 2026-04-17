import { getEnabledModuleIds } from '@maskin/module-sdk'
import { KNOWLEDGE_NUDGES } from '@maskin/shared'

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI agent.'

/**
 * Build the container `SYSTEM_PROMPT` env var for a session.
 *
 * Module-specific nudges (e.g. the knowledge-wiki retrieval nudge) are appended
 * here instead of being baked into each agent's stored `systemPrompt`, so they
 * only surface in workspaces where the relevant module is enabled.
 */
export function buildAgentSystemPrompt(
	agentSystemPrompt: string | null | undefined,
	workspaceSettings: Record<string, unknown> | null | undefined,
): string {
	let prompt = agentSystemPrompt ?? DEFAULT_SYSTEM_PROMPT

	if (getEnabledModuleIds(workspaceSettings).includes('knowledge')) {
		prompt = `${prompt}\n\n${KNOWLEDGE_NUDGES}`
	}

	return prompt
}
