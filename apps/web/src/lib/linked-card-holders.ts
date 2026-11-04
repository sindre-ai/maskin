/** One message that draws cards, with the objects it links, in the order the chat shows them. */
export interface CardMessage {
	id: number
	createdAt: string | null
	linkedIds: readonly string[]
}

/**
 * What the edit history of a draft says. `ready` carries the times its title, text or metadata
 * changed. `loading` and `failed` are the two ways the history can be missing.
 */
export type DraftHistory =
	| { state: 'ready'; editedAt: readonly string[] }
	| { state: 'loading' }
	| { state: 'failed' }

/** What one message must do for the objects it links. */
export interface MessagePlacement {
	/** Ids this message draws as a chip because another message holds their card. */
	skipIds: ReadonlySet<string>
	/** Ids this message holds as a revised draft's card: the card gets an Updated tag. */
	updatedIds: ReadonlySet<string>
}

/**
 * Which message holds the card for each linked object. The first message that links an object
 * holds its card and every later link is a chip. A draft is the exception: when it was edited
 * after the message that holds its card was written, the next message that links it takes the
 * card with an Updated tag and the earlier one drops to a chip. A draft linked again unchanged
 * stays a chip, and so does a link to an approved draft (an approval is not an edit).
 *
 * `isDraft` and `history` are only asked about ids linked more than once, so a chat with no
 * repeat links reads nothing from the cache. While the history of a draft is loading the first
 * message keeps the card, so the card does not jump before the answer is known. If it failed, the
 * newest message takes the card without an Updated tag: the tag is never guessed.
 */
export function decideLinkedPlacements(
	messages: readonly CardMessage[],
	isDraft: (id: string) => boolean,
	history: (id: string) => DraftHistory,
): Map<number, MessagePlacement> {
	const skip = new Map<number, Set<string>>()
	const updated = new Map<number, Set<string>>()
	const holders = new Map<string, CardMessage>()
	for (const message of messages) {
		skip.set(message.id, new Set())
		updated.set(message.id, new Set())
	}
	for (const message of messages) {
		for (const id of message.linkedIds) {
			const holder = holders.get(id)
			if (!holder) {
				holders.set(id, message)
				continue
			}
			const take = isDraft(id) ? takesTheCard(history(id), holder.createdAt) : null
			if (take === null) {
				skip.get(message.id)?.add(id)
				continue
			}
			skip.get(holder.id)?.add(id)
			updated.get(holder.id)?.delete(id)
			if (take === 'updated') updated.get(message.id)?.add(id)
			holders.set(id, message)
		}
	}
	return new Map(
		messages.map((message) => [
			message.id,
			{
				skipIds: skip.get(message.id) ?? new Set(),
				updatedIds: updated.get(message.id) ?? new Set(),
			},
		]),
	)
}

// `null`: the holder keeps the card. Otherwise the later message takes it, tagged or not.
function takesTheCard(
	history: DraftHistory,
	holderCreatedAt: string | null,
): 'updated' | 'plain' | null {
	if (history.state === 'failed') return 'plain'
	if (history.state === 'loading' || !holderCreatedAt) return null
	const since = Date.parse(holderCreatedAt)
	return history.editedAt.some((at) => Date.parse(at) > since) ? 'updated' : null
}

/** The ids linked by more than one message: the only ones whose draft status and history are read. */
export function idsLinkedMoreThanOnce(messages: readonly CardMessage[]): string[] {
	const counts = new Map<string, number>()
	for (const message of messages) {
		for (const id of message.linkedIds) counts.set(id, (counts.get(id) ?? 0) + 1)
	}
	return [...counts].filter(([, count]) => count > 1).map(([id]) => id)
}

/** The fields of an object whose change counts as editing a draft. A status move does not. */
const CONTENT_FIELDS = new Set(['title', 'content', 'metadata'])

/**
 * The times an object's title, text or metadata changed, from its event history. Approving a
 * draft writes an `approved` event and a plain status move lists only `status`, so neither
 * counts. (Object `updatedAt` cannot tell these apart: a status move bumps it.)
 */
export function editTimes(
	events: readonly {
		action: string
		createdAt: string | null
		data: Record<string, unknown> | null
	}[],
): string[] {
	const times: string[] = []
	for (const event of events) {
		if (event.action !== 'updated' && event.action !== 'status_changed') continue
		if (!event.createdAt) continue
		const changes = event.data?.changes
		if (
			Array.isArray(changes) &&
			changes.some(
				(change) =>
					typeof change === 'object' &&
					change !== null &&
					CONTENT_FIELDS.has((change as { field?: unknown }).field as string),
			)
		) {
			times.push(event.createdAt)
		}
	}
	return times
}
