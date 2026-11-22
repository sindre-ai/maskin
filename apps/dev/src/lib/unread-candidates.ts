import type { Database } from '@maskin/db'
import { commentMentions, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'

/**
 * Past this many candidate entities the narrowing is skipped and the unread query runs over every
 * subscription, as it did before. Keeps the id list well under the driver's parameter limit.
 */
export const MAX_UNREAD_CANDIDATE_ENTITIES = 5_000

/**
 * The entities that can have an unread item for this actor at all: those with a comment by someone
 * else that mentions them, and the workspace's onboarding coach threads (which count without a
 * mention). Both are cheap to list, whereas the aggregate in GET /api/subscriptions/unread probes
 * `events` and `read_state` once per subscription, which cost 500 ms for a person with 2,800
 * subscriptions when only one of them had anything unread. Null means the list was too long to be
 * worth passing on.
 *
 * Mentions come from comment_mentions, one row per person and entity, which a trigger on `events`
 * fills as each comment is saved. Reading the comments themselves took 3 s cold for one person
 * (about 10,000 comment rows to keep 548 entities). A comment's mentions are fixed when it is
 * written, so a row never needs removing; the unread query still decides what counts.
 */
export async function unreadCandidateEntityIds(
	db: Database,
	workspaceId: string,
	actorId: string,
): Promise<string[] | null> {
	const [mentioned, onboarding] = await Promise.all([
		db
			.select({ entityId: commentMentions.entityId })
			.from(commentMentions)
			.where(
				and(eq(commentMentions.workspaceId, workspaceId), eq(commentMentions.actorId, actorId)),
			),
		db
			.select({ id: objects.id })
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'onboarding_session'))),
	])
	const ids = new Set([...mentioned.map((r) => r.entityId), ...onboarding.map((r) => r.id)])
	return ids.size > MAX_UNREAD_CANDIDATE_ENTITIES ? null : [...ids]
}
