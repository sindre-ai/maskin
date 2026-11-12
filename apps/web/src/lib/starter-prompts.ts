import { type ActorListItem, normalizeStarterPrompts } from '@maskin/shared'

/**
 * The starter prompts to offer in a chat: those of the one agent in it. With no agent, or with
 * several (a group), nobody's openers fit, so nothing is offered. An agent that set none offers
 * none; there is no stand-in list. Read through the same normaliser the server writes with, so a
 * stale or hand-edited value never becomes an unsendable chip.
 */
export function starterPromptsForAgents(
	agentIds: readonly string[],
	actors: readonly Pick<ActorListItem, 'id' | 'starter_prompts'>[] | undefined,
): string[] {
	if (agentIds.length !== 1) return []
	const agent = actors?.find((a) => a.id === agentIds[0])
	return normalizeStarterPrompts(agent?.starter_prompts)
}
