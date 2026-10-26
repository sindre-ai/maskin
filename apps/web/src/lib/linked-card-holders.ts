/** One message that draws cards, with the objects it links, in the order the chat shows them. */
export interface CardMessage {
	id: number
	createdAt: string | null
	linkedIds: readonly string[]
}

/**
 * What a message draws for a linked object: the full `card`, the card with an Updated tag
 * (a draft revised since the message that held it before), or a compact `row`.
 */
export type LinkedDraw = 'card' | 'updated' | 'row'

/**
 * Which message holds the card for each linked object, per message and id. The first message
 * that links an object holds its card; later links are rows. A draft is the exception: when it
 * changed after the message that holds its card was written, the next message that links it
 * takes the card and tags it Updated, and the earlier one drops to a row. A draft linked again
 * unchanged stays a row.
 *
 * `isDraft` and `changedSince` are only asked about ids linked more than once, so a chat with no
 * repeat links reads nothing from the cache. An id missing from a message's map is one the
 * message does not link.
 */
export function decideLinkedDraws(
	messages: readonly CardMessage[],
	isDraft: (id: string) => boolean,
	changedSince: (id: string, sinceIso: string) => boolean,
): Map<number, ReadonlyMap<string, LinkedDraw>> {
	const byMessage = new Map<number, Map<string, LinkedDraw>>()
	const holders = new Map<string, CardMessage>()
	for (const message of messages) {
		const draws = new Map<string, LinkedDraw>()
		byMessage.set(message.id, draws)
		for (const id of message.linkedIds) {
			const holder = holders.get(id)
			if (!holder) {
				holders.set(id, message)
				draws.set(id, 'card')
			} else if (holder.createdAt && isDraft(id) && changedSince(id, holder.createdAt)) {
				byMessage.get(holder.id)?.set(id, 'row')
				holders.set(id, message)
				draws.set(id, 'updated')
			} else {
				draws.set(id, 'row')
			}
		}
	}
	return byMessage
}

/** The fields of an object whose change counts as editing a draft. A status move does not. */
const CONTENT_FIELDS = new Set(['title', 'content', 'metadata'])

/**
 * Whether an object's event history holds an edit to its text after `sinceIso`. Approving a
 * draft writes an `approved` event and a status move lists only `status`, so neither counts.
 * (Object `updatedAt` cannot tell these apart: a status move bumps it.)
 */
export function editedSince(
	events: readonly { action: string; createdAt: string | null; data: Record<string, unknown> | null }[],
	sinceIso: string,
): boolean {
	const since = Date.parse(sinceIso)
	return events.some((event) => {
		if (event.action !== 'updated' && event.action !== 'status_changed') return false
		if (!event.createdAt || Date.parse(event.createdAt) <= since) return false
		const changes = event.data?.changes
		return (
			Array.isArray(changes) &&
			changes.some(
				(change) =>
					typeof change === 'object' &&
					change !== null &&
					CONTENT_FIELDS.has((change as { field?: unknown }).field as string),
			)
		)
	})
}
