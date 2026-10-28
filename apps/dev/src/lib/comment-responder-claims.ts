import type { Database } from '@maskin/db'
import { type CommentResponderClaimedBy, commentResponderClaims } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { logger } from './logger'

/**
 * Claim the right to start a responder session for `actorId` on one comment event.
 *
 * Two paths can each start a session for the same actor on the same comment: the thread-reply
 * auto-spawn (`routes/events.ts`) and the CommentDispatcher fallback ladder
 * (`services/trigger-runner.ts`). They run ~50ms apart in different code paths (request handler
 * vs. PG NOTIFY subscriber), so no read-then-write check can separate them. Instead each path
 * INSERTs a row keyed `(source_comment_event_id, actor_id)` first; the primary key lets exactly
 * one INSERT succeed (migration 0115). Returns true when this caller won and should start the
 * session, false when another path already holds the claim and this caller must stand down.
 *
 * Fails open: if the claim itself cannot be written (DB error), answer anyway. A duplicate reply is
 * recoverable noise; a comment nobody answers is the failure the responder ladder exists to prevent.
 */
export async function claimCommentResponder(
	db: Database,
	ctx: {
		sourceCommentEventId: number
		actorId: string
		claimedBy: CommentResponderClaimedBy
	},
): Promise<boolean> {
	try {
		const rows = await db
			.insert(commentResponderClaims)
			.values({
				sourceCommentEventId: ctx.sourceCommentEventId,
				actorId: ctx.actorId,
				claimedBy: ctx.claimedBy,
			})
			.onConflictDoNothing()
			.returning({ actorId: commentResponderClaims.actorId })
		return rows.length > 0
	} catch (err) {
		logger.error('Failed to claim comment responder; proceeding without dedupe', {
			source_comment_event_id: ctx.sourceCommentEventId,
			actor_id: ctx.actorId,
			claimed_by: ctx.claimedBy,
			error: err instanceof Error ? err.message : String(err),
		})
		return true
	}
}

/**
 * Give a claim back after the session it was taken for failed to start, so the comment is not left
 * with a claim and no responder. Best-effort.
 */
export async function releaseCommentResponderClaim(
	db: Database,
	ctx: { sourceCommentEventId: number; actorId: string },
): Promise<void> {
	try {
		await db
			.delete(commentResponderClaims)
			.where(
				and(
					eq(commentResponderClaims.sourceCommentEventId, ctx.sourceCommentEventId),
					eq(commentResponderClaims.actorId, ctx.actorId),
				),
			)
	} catch (err) {
		logger.warn('Failed to release comment responder claim', {
			source_comment_event_id: ctx.sourceCommentEventId,
			actor_id: ctx.actorId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
