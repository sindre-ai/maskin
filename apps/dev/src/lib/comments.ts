import type { Database } from '@maskin/db'
import { events, actors, subscriptions } from '@maskin/db/schema'
import type { CommentDecision } from '@maskin/shared'
import { inArray } from 'drizzle-orm'

export interface PostCommentInput {
	workspaceId: string
	actorId: string
	entityId: string
	entityType?: string
	content: string
	mentions?: string[]
	parentEventId?: number
	attachmentFileIds?: string[]
	metadata?: unknown
	/**
	 * Structured decision block (see `commentDecisionSchema`). Validated by the
	 * caller before it gets here; stored alongside the body so the For You feed
	 * can render its options as real buttons.
	 */
	decision?: CommentDecision
	attention?: number
}

export interface PostCommentResult {
	comment: typeof events.$inferSelect
	/**
	 * Mention ids from the request that matched no row in `actors`. Callers
	 * surface these back to the client — an agent posting over MCP typically
	 * transcribed a UUID out of its system prompt and fumbled a character, and
	 * silently dropping the mention means the human it was trying to reach is
	 * never notified.
	 */
	unresolvedMentions: string[]
}

/**
 * Core comment-creation logic: insert the `commented` event and auto-subscribe
 * the commenter + mentions. Shared by `POST /api/events` and any backend code
 * that needs to post a comment programmatically.
 *
 * Does NOT create notifications or spawn agent sessions — the `comment_posted`
 * subscriber in `trigger-runner.ts` (`CommentDispatcher`) is the single code
 * path that owns comment→dispatch and reads the `commented` event off the
 * `PgNotifyBridge` after this transaction commits.
 */
export async function postComment(
	db: Database,
	input: PostCommentInput,
): Promise<PostCommentResult> {
	const entityType = input.entityType ?? 'object'

	return db.transaction(async (tx) => {
		const results = await tx
			.insert(events)
			.values({
				workspaceId: input.workspaceId,
				actorId: input.actorId,
				action: 'commented',
				entityType,
				entityId: input.entityId,
				data: {
					content: input.content,
					mentions: input.mentions,
					parentEventId: input.parentEventId,
					attachmentFileIds: input.attachmentFileIds,
					metadata: input.metadata,
					decision: input.decision,
					attention: input.attention,
				},
			})
			.returning()

		const comment = results[0]
		if (!comment) {
			throw new Error('Failed to create comment')
		}

		// Mention ids come straight off the request body, so they can reference
		// actors that never existed or were deleted since the client rendered the
		// composer. Resolve them against `actors` here so callers can surface
		// unresolved ids back to the client and so the auto-subscribe below never
		// tries to insert an unknown id into `subscriptions.actor_id` (which
		// would violate its FK and abort the whole comment).
		let existingMentionedIds: string[] = []
		let unresolvedMentions: string[] = []

		if (input.mentions?.length) {
			const mentionedActors = await tx
				.select({ id: actors.id })
				.from(actors)
				.where(inArray(actors.id, input.mentions))

			existingMentionedIds = mentionedActors.map((a) => a.id)
			const existingSet = new Set(existingMentionedIds)
			unresolvedMentions = Array.from(new Set(input.mentions)).filter((id) => !existingSet.has(id))
		}

		// Auto-subscribe the commenter — anyone who comments on an entity starts
		// watching it for future activity (Slack-channel-style). On conflict we
		// keep the existing source so author/manual subscriptions are never
		// downgraded to 'commenter'.
		await tx
			.insert(subscriptions)
			.values({
				workspaceId: input.workspaceId,
				actorId: input.actorId,
				entityType,
				entityId: input.entityId,
				source: 'commenter',
			})
			.onConflictDoNothing({
				target: [subscriptions.actorId, subscriptions.entityType, subscriptions.entityId],
			})

		// Auto-subscribe @-mentioned actors so the comment reaches their For You
		// page even if they weren't already subscribed.
		if (existingMentionedIds.length > 0) {
			const uniqueMentioned = Array.from(new Set(existingMentionedIds)).filter(
				(id) => id !== input.actorId,
			)
			if (uniqueMentioned.length > 0) {
				await tx
					.insert(subscriptions)
					.values(
						uniqueMentioned.map((mentionedActorId) => ({
							workspaceId: input.workspaceId,
							actorId: mentionedActorId,
							entityType,
							entityId: input.entityId,
							source: 'mentioned' as const,
						})),
					)
					.onConflictDoNothing({
						target: [subscriptions.actorId, subscriptions.entityType, subscriptions.entityId],
					})
			}
		}

		return { comment, unresolvedMentions }
	})
}
