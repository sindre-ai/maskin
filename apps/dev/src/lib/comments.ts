import type { Database } from '@maskin/db'
import { events, actors } from '@maskin/db/schema'
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
 * Core comment-creation logic: insert the `commented` event and resolve any
 * @-mentions against `actors`. Shared by `POST /api/events` and any backend
 * code that needs to post a comment programmatically.
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
		// composer. Resolve them against `actors` so callers can surface
		// unresolved ids back to the client.
		let unresolvedMentions: string[] = []
		if (input.mentions?.length) {
			const mentionedActors = await tx
				.select({ id: actors.id })
				.from(actors)
				.where(inArray(actors.id, input.mentions))
			const existingSet = new Set(mentionedActors.map((a) => a.id))
			unresolvedMentions = Array.from(new Set(input.mentions)).filter((id) => !existingSet.has(id))
		}

		return { comment, unresolvedMentions }
	})
}
