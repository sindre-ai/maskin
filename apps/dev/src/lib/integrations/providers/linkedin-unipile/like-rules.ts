import type { Database } from '@maskin/db'
import { linkedinActions } from '@maskin/db/schema'
import { and, asc, eq, gt, or } from 'drizzle-orm'
import { LinkedInActionRefusal } from './action-log'
import { PENDING_HOLDS_SLOT_MS } from './caps'

/**
 * The two like rules that read the action log, beyond the daily cap (which the wrapper
 * enforces): no second like on posts by one author inside 7 days, and no second like on a post
 * this account already liked. Both count rows of react_to_post for the connected account.
 */

export const LIKE_AUTHOR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Call this from inside the react_to_post `withActionLog` run, with the author named in the
 * spec's `targetProviderId`, so this call's own `pending` row is already in the log.
 *
 * - A prior `ok` like on this post: `{ already_liked: true }`, nothing is sent. This runs
 *   before the author rule, so liking the same post again is an answer, not a refusal.
 * - Else an `ok` like on another post by this author in the last 7 days refuses with
 *   `refused_rule`. A `pending` row for the author from the last two minutes counts too, and
 *   this call's own is one of them, so a second pending row means a parallel like is in
 *   flight and both refuse rather than both go out.
 */
export async function checkLikeRules(
	db: Database,
	input: {
		integrationId: string
		postId: string
		authorProviderId: string
		now?: () => Date
	},
): Promise<{ already_liked: boolean }> {
	const prior = await db
		.select({ id: linkedinActions.id })
		.from(linkedinActions)
		.where(
			and(
				eq(linkedinActions.integrationId, input.integrationId),
				eq(linkedinActions.tool, 'react_to_post'),
				eq(linkedinActions.refId, input.postId),
				eq(linkedinActions.outcome, 'ok'),
			),
		)
		.limit(1)
	if (prior.length > 0) return { already_liked: true }

	const now = (input.now ?? (() => new Date()))()
	const rows = await db
		.select({ createdAt: linkedinActions.createdAt, outcome: linkedinActions.outcome })
		.from(linkedinActions)
		.where(
			and(
				eq(linkedinActions.integrationId, input.integrationId),
				eq(linkedinActions.tool, 'react_to_post'),
				eq(linkedinActions.targetProviderId, input.authorProviderId),
				gt(linkedinActions.createdAt, new Date(now.getTime() - LIKE_AUTHOR_WINDOW_MS)),
				or(
					eq(linkedinActions.outcome, 'ok'),
					and(
						eq(linkedinActions.outcome, 'pending'),
						gt(linkedinActions.createdAt, new Date(now.getTime() - PENDING_HOLDS_SLOT_MS)),
					),
				),
			),
		)
		.orderBy(asc(linkedinActions.createdAt))
	const liked = rows.find((r) => r.outcome === 'ok')
	if (liked) {
		const freeAt = new Date(liked.createdAt.getTime() + LIKE_AUTHOR_WINDOW_MS)
		throw new LinkedInActionRefusal(
			'refused_rule',
			'INVALID_INPUT',
			`This account already liked a post by this author in the last 7 days; the limit is one like per author per 7 days. Nothing was sent. Try this author again after ${freeAt.toISOString()}.`,
		)
	}
	if (rows.filter((r) => r.outcome === 'pending').length > 1) {
		throw new LinkedInActionRefusal(
			'refused_rule',
			'INVALID_INPUT',
			'Another like on a post by this author is in progress, and the limit is one like per author per 7 days. Nothing was sent. Check the post again in a few minutes.',
		)
	}
	return { already_liked: false }
}
