import type { Database } from '@maskin/db'
import { type events, youtubePendingActions } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { renderYoutubeActionCard } from './card'

type EventRow = typeof events.$inferSelect

/** The pending YouTube action a card event is about; only the server writes this key. */
export function youtubeActionIdOf(event: EventRow): string | undefined {
	const id = (event.data as { youtube_action_id?: unknown } | null)?.youtube_action_id
	return typeof id === 'string' ? id : undefined
}

/**
 * Keeps the YouTube cards whose action is still waiting for a decision and draws each again from
 * the stored row, so what a person reads is what the row holds, whatever the card event says.
 * A card whose action was decided, expired or ended leaves the list.
 */
export async function liveYoutubeCards(
	db: Database,
	workspaceId: string,
	cards: EventRow[],
): Promise<EventRow[]> {
	const ids = cards.flatMap((event) => youtubeActionIdOf(event) ?? [])
	if (ids.length === 0) return cards
	const rows = await db
		.select()
		.from(youtubePendingActions)
		.where(
			and(
				eq(youtubePendingActions.workspaceId, workspaceId),
				inArray(youtubePendingActions.id, ids),
			),
		)
	const byId = new Map(rows.map((row) => [row.id, row]))
	return cards.flatMap((event) => {
		const id = youtubeActionIdOf(event)
		if (!id) return [event]
		const row = byId.get(id)
		if (!row || row.status !== 'pending' || row.payload === null) return []
		if (row.expiresAt.getTime() <= Date.now()) return []
		const { content, decision } = renderYoutubeActionCard(row)
		return [{ ...event, data: { ...(event.data as object), content, decision } }]
	})
}
