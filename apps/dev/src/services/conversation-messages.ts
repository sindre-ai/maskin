import type { Database } from '@maskin/db'
import { events, conversations, messages } from '@maskin/db/schema'
import type { MessageMetadata } from '@maskin/shared'
import { eq } from 'drizzle-orm'

export type InsertConversationMessageArgs = {
	conversationId: string
	workspaceId: string
	/** The author — human or agent; role is derived from actors.type. */
	actorId: string
	content: string
	metadata: MessageMetadata | null
	sessionId: string | null
	kind?: 'message' | 'system'
	/**
	 * Branch to write onto. Omit to use the conversation's active branch, which
	 * is what every caller wants — resolving it here rather than at each call
	 * site is deliberate, because a message that silently lands on the root
	 * branch would be visible from every branch at once.
	 */
	branchId?: string | null
}

export type InsertedConversationMessage = typeof messages.$inferSelect

/**
 * The mechanics of putting a message into a conversation: insert the row, bump
 * the conversation's denormalized `lastMessageAt`, and log the `message_posted`
 * event that drives the audit trail and SSE invalidation.
 *
 * Shared by the POST /conversations/:id/messages route (human + MCP-authored
 * messages) and the interactive turn finalizer (an agent's auto-posted
 * end-of-turn output), so the three writes can't drift apart between them.
 *
 * Deliberately does NOT run route policy — @mention auto-join, auto-titling,
 * and `evaluateAndRespond` stay with the route. That omission is what makes an
 * auto-posted final output structurally incapable of waking another agent.
 *
 * Returns null when the insert was suppressed by a unique constraint — the
 * finalizer's dedupe key. Callers that can't conflict should treat null as an
 * error.
 */
export async function insertConversationMessage(
	db: Database,
	args: InsertConversationMessageArgs,
): Promise<InsertedConversationMessage | null> {
	let branchId = args.branchId
	if (branchId === undefined) {
		const [conversation] = await db
			.select({ activeBranchId: conversations.activeBranchId })
			.from(conversations)
			.where(eq(conversations.id, args.conversationId))
			.limit(1)
		branchId = conversation?.activeBranchId ?? null
	}

	const [created] = await db
		.insert(messages)
		.values({
			conversationId: args.conversationId,
			actorId: args.actorId,
			content: args.content,
			metadata: args.metadata,
			sessionId: args.sessionId,
			branchId,
			...(args.kind ? { kind: args.kind } : {}),
		})
		.onConflictDoNothing()
		.returning()

	if (!created) return null

	await db
		.update(conversations)
		.set({ lastMessageAt: created.createdAt ?? new Date(), updatedAt: new Date() })
		.where(eq(conversations.id, args.conversationId))

	await db.insert(events).values({
		workspaceId: args.workspaceId,
		actorId: args.actorId,
		action: 'message_posted',
		entityType: 'conversation',
		entityId: args.conversationId,
		data: { message_id: created.id, author_actor_id: args.actorId },
	})

	return created
}
