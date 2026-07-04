import type { ActorListItem } from '@/lib/api'

/**
 * Derives the mentions array for a comment by checking which mentionable
 * actors' `@Name` literally appears in the text. Used by reply surfaces that
 * don't have an @-autocomplete UI (e.g. PersistentReplyBar) — comment-input.tsx's
 * dropdown-driven flow does its own reconciliation against inserted mentions.
 */
export function parseMentions(text: string, actors: ActorListItem[]): string[] {
	const ids: string[] = []
	for (const actor of actors) {
		if (text.includes(`@${actor.name}`)) ids.push(actor.id)
	}
	return ids
}
