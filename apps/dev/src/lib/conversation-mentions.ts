import type { SessionManager } from '../services/session-manager'
import { logger } from './logger'

export interface AgentMention {
	agentId: string
	name: string
}

/** Matches `@name` tokens in free text — names are compared with whitespace stripped. */
export const MENTION_TOKEN_RE = /@([\w-]+)/g

/** Fire-and-forget: spawn a session per @mentioned agent, scoped to the conversation. */
export function dispatchMentionSessions(
	sessionManager: SessionManager,
	workspaceId: string,
	conversationId: string,
	createdBy: string,
	conversationTitle: string | null,
	messageContent: string,
	mentions: AgentMention[],
) {
	for (const mention of mentions) {
		sessionManager
			.createSession(workspaceId, {
				actorId: mention.agentId,
				actionPrompt: `You were @mentioned in conversation "${conversationTitle ?? conversationId}".`,
				config: { message_content: messageContent },
				conversationId,
				createdBy,
				autoStart: true,
			})
			.catch((err: unknown) => {
				logger.error('Failed to spawn session for @mentioned agent', {
					agentId: mention.agentId,
					conversationId,
					err,
				})
			})
	}
}
