import type { Database } from '@maskin/db'
import { messages } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { chatReplyPath, trackChatReplyPosted } from '../lib/analytics/chat-reply-events'
import { logger } from '../lib/logger'

/**
 * Reports one agent reply in a chat as chat_reply_posted: where the session lives, where the
 * reply went, and how long after the message that started the turn. Fire-and-forget and never
 * throws, so a tracking failure cannot cost a reply.
 */
export function reportChatReply(
	db: Database,
	reply: {
		workspaceId: string
		conversationId: string
		agentId: string
		sessionThreadRootId: number | null
		replyThreadRootId: number | null
		originMessageId: number | null
		source: 'final_output' | 'post'
	},
): void {
	const run = async () => {
		let originThreadRootId: number | null = null
		let latencyMs: number | null = null
		if (reply.originMessageId !== null) {
			const [origin] = await db
				.select({ threadRootId: messages.threadRootId, createdAt: messages.createdAt })
				.from(messages)
				.where(eq(messages.id, reply.originMessageId))
				.limit(1)
			if (origin) {
				originThreadRootId = origin.threadRootId ?? null
				latencyMs = Math.max(0, Date.now() - origin.createdAt.getTime())
			}
		}
		await trackChatReplyPosted({
			workspaceId: reply.workspaceId,
			conversationId: reply.conversationId,
			agentId: reply.agentId,
			sessionThreadRootId: reply.sessionThreadRootId,
			replyThreadRootId: reply.replyThreadRootId,
			originThreadRootId,
			originMessageId: reply.originMessageId,
			latencyMs,
			path: chatReplyPath(reply.sessionThreadRootId, originThreadRootId),
			source: reply.source,
		})
	}
	run().catch((err: unknown) =>
		logger.warn('Failed to assemble chat_reply_posted', {
			conversationId: reply.conversationId,
			error: String(err),
		}),
	)
}
