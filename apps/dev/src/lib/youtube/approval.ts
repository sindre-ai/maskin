import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { YOUTUBE_APPROVE_LABEL, YOUTUBE_REJECT_LABEL } from './card'

/**
 * A person's tap on a YouTube action card, read the way a status button is: the reply names the
 * card (its parent) and carries the label of the option picked. The action the tap is for comes
 * from the card event, whose action id only the server writes (see `postYoutubeActionCard`), never
 * from the reply text. The caller still has to check the actor is a person, which the events route
 * does with the same `mayApprove` rule as every other approval.
 */

export interface YoutubeActionTap {
	cardEventId: number
	actionId: string
	decision: 'approve' | 'reject'
	/** The hash of the request the card showed. */
	payloadHash: string | undefined
}

export async function resolveYoutubeActionTap(
	db: Database,
	params: {
		workspaceId: string
		entityId: string
		parentEventId: number | undefined
		content: string
	},
): Promise<YoutubeActionTap | null> {
	if (params.parentEventId === undefined) return null
	const reply = params.content.trim()
	const decision =
		reply === YOUTUBE_APPROVE_LABEL ? 'approve' : reply === YOUTUBE_REJECT_LABEL ? 'reject' : null
	if (!decision) return null

	const [card] = await db
		.select({ id: events.id, data: events.data })
		.from(events)
		.where(
			and(
				eq(events.id, params.parentEventId),
				eq(events.workspaceId, params.workspaceId),
				eq(events.entityId, params.entityId),
				eq(events.action, 'commented'),
			),
		)
		.limit(1)
	const actionId = (card?.data as { youtube_action_id?: unknown } | null)?.youtube_action_id
	if (!card || typeof actionId !== 'string') return null
	const hash = (card.data as { youtube_payload_hash?: unknown }).youtube_payload_hash
	return {
		cardEventId: Number(card.id),
		actionId,
		decision,
		payloadHash: typeof hash === 'string' ? hash : undefined,
	}
}
