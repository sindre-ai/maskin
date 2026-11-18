import type { Database, Transaction } from '@maskin/db'
import { youtubePendingActions } from '@maskin/db/schema'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { YoutubeError } from '../integrations/providers/youtube/errors'
import type { YoutubeActionKind } from './actions'

/**
 * Extra caps on the writes that reach other people: comments and likes. They sit on top of the
 * person's approval and follow the consent rule (III.I) and the spam policy. A day is the Pacific
 * calendar day, the same day the quota resets on.
 *
 * What counts is what was asked for and not turned down: pending, approved and executed actions.
 * A rejected, expired or failed one never reached YouTube, so it frees its place. The check runs
 * inside the transaction that stores the action, behind a lock on the workspace, so parallel
 * calls cannot both pass a check that only one of them should.
 */

export const COMMENTS_PER_DAY = 10
export const LIKES_PER_DAY = 20
export const COMMENTS_PER_VIDEO_PER_DAY = 3

const COMMENT_KINDS: YoutubeActionKind[] = ['post_comment', 'reply_to_comment']
const COUNTED_STATUSES = ['pending', 'approved', 'executed']

type Writer = Database | Transaction

/** The text a comment is compared by: case, spacing and edge whitespace do not make it new. */
export function normalizeCommentText(text: string): string {
	return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

const startOfPacificDay = sql`(date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles')`

async function countToday(
	tx: Writer,
	workspaceId: string,
	kinds: YoutubeActionKind[],
	videoId?: string,
): Promise<number> {
	const [row] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(youtubePendingActions)
		.where(
			and(
				eq(youtubePendingActions.workspaceId, workspaceId),
				inArray(youtubePendingActions.kind, kinds),
				inArray(youtubePendingActions.status, COUNTED_STATUSES),
				gte(youtubePendingActions.createdAt, startOfPacificDay),
				...(videoId ? [eq(youtubePendingActions.targetVideoId, videoId)] : []),
			),
		)
	return Number(row?.n ?? 0)
}

function capReached(message: string): YoutubeError {
	return new YoutubeError({
		code: 'CAP_REACHED',
		message,
		hint: 'The count starts again at midnight Pacific time.',
	})
}

/**
 * Throws CAP_REACHED when this comment or like would go over a cap. Call it inside the
 * transaction that stores the action (see `beforeInsert` in `createPendingAction`).
 */
export async function assertWithinYoutubeCaps(
	tx: Transaction,
	params: {
		workspaceId: string
		kind: YoutubeActionKind
		targetVideoId: string | null
		textHash: string | null
	},
): Promise<void> {
	const isComment = COMMENT_KINDS.includes(params.kind)
	if (!isComment && params.kind !== 'like') return

	// Held until this transaction ends. One lock per workspace, so only the caps wait on each other.
	await tx.execute(
		sql`SELECT pg_advisory_xact_lock(hashtext(${`youtube_caps:${params.workspaceId}`}))`,
	)

	if (params.kind === 'like') {
		if ((await countToday(tx, params.workspaceId, ['like'])) >= LIKES_PER_DAY) {
			throw capReached(`This workspace has already asked for ${LIKES_PER_DAY} likes today.`)
		}
		return
	}

	if (params.textHash) {
		const [same] = await tx
			.select({ id: youtubePendingActions.id })
			.from(youtubePendingActions)
			.where(
				and(
					eq(youtubePendingActions.workspaceId, params.workspaceId),
					eq(youtubePendingActions.textHash, params.textHash),
					inArray(youtubePendingActions.status, COUNTED_STATUSES),
				),
			)
			.limit(1)
		if (same) {
			throw new YoutubeError({
				code: 'CAP_REACHED',
				message: 'This workspace has already asked for a comment with the same text.',
				hint: 'Write a different comment. The same text is never posted twice.',
			})
		}
	}
	if ((await countToday(tx, params.workspaceId, COMMENT_KINDS)) >= COMMENTS_PER_DAY) {
		throw capReached(`This workspace has already asked for ${COMMENTS_PER_DAY} comments today.`)
	}
	if (
		params.targetVideoId &&
		(await countToday(tx, params.workspaceId, COMMENT_KINDS, params.targetVideoId)) >=
			COMMENTS_PER_VIDEO_PER_DAY
	) {
		throw capReached(
			`This video has already had ${COMMENTS_PER_VIDEO_PER_DAY} comments asked for today.`,
		)
	}
}
