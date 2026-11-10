import type { MessageReaction } from './api'

/** The five the picker offers, in order. Same set and order as the iOS message menu. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '✅', '👀'] as const

/** True when the caller is one of the people who reacted with `emoji`. */
export function hasReacted(reactions: MessageReaction[] | undefined, emoji: string): boolean {
	return reactions?.find((r) => r.emoji === emoji)?.reactedByMe ?? false
}

/**
 * The list with the caller's `emoji` reaction put in the wanted state. It sets a state and does
 * not flip one, so applying it twice, or undoing a change that a later tap already reversed, is
 * a no-op. Counts never go below zero, an emoji nobody uses any more disappears, and a new one
 * goes last (the server orders by first use).
 */
export function setReacted(
	reactions: MessageReaction[] | undefined,
	emoji: string,
	me: { id: string; name: string },
	reacted: boolean,
): MessageReaction[] {
	const list = reactions ?? []
	const index = list.findIndex((r) => r.emoji === emoji)
	const current = index === -1 ? undefined : list[index]
	if (reacted) {
		if (!current) {
			return [
				...list,
				{ emoji, count: 1, reactedByMe: true, actors: [{ actorId: me.id, actorName: me.name }] },
			]
		}
		if (current.reactedByMe) return list
		return list.map((r, i) =>
			i === index
				? {
						...r,
						count: r.count + 1,
						reactedByMe: true,
						actors: [...r.actors, { actorId: me.id, actorName: me.name }],
					}
				: r,
		)
	}
	if (!current || !current.reactedByMe) return list
	const count = Math.max(current.count - 1, 0)
	if (count === 0) return list.filter((_, i) => i !== index)
	return list.map((r, i) =>
		i === index
			? {
					...r,
					count,
					reactedByMe: false,
					actors: r.actors.filter((a) => a.actorId !== me.id),
				}
			: r,
	)
}

/** "You, Magnus and 2 others reacted with 👍" for a chip's tooltip and screen-reader label. */
export function reactionLabel(reaction: MessageReaction, meId: string | undefined): string {
	// Who is "You" is decided by id, never by the name a person happens to have.
	const isMe = (actorId: string) => meId !== undefined && actorId === meId
	const names = [
		...reaction.actors.filter((a) => isMe(a.actorId)).map(() => 'You'),
		...reaction.actors.filter((a) => !isMe(a.actorId)).map((a) => a.actorName),
	]
	const shown = names.slice(0, 3)
	const rest = names.length - shown.length
	const who =
		rest > 0
			? `${shown.join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`
			: shown.length > 1
				? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
				: (shown[0] ?? '')
	return `${who} reacted with ${reaction.emoji}`
}
