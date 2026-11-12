import type { ConversationListItemResponse } from '@/lib/api'

type SnippetFields = Pick<
	ConversationListItemResponse,
	'participants' | 'snippet_actor_id' | 'snippet_actor_name'
>

/**
 * How two names are compared when deciding whether a preview would only repeat the row title.
 * The iOS twin is `NameMatch` (MaskinCore/Chats/PreviewAuthor.swift). Both do the same steps in
 * the same order and share their test cases: trim, decompose (NFD), drop combining marks,
 * upper-case then lower-case (so ß meets "SS" and İ meets "i").
 */
export function foldName(name: string): string {
	return name.trim().normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().toLowerCase()
}

export function sameName(a: string, b: string): boolean {
	return foldName(a) === foldName(b)
}

/**
 * Who a chat row's preview names, or null when it should not say. The one place this is decided
 * (the iOS twin is `ConversationSummary.snippetAuthorLead`).
 *
 * The viewer reads as "You". Anyone else is named, except when the name would only repeat the
 * title the row *displays* (`displayedTitle`, which the caller passes). That is only allowed when
 * the chat is provably a direct one: exactly two participants, the viewer among them. Without the
 * viewer's id, or with a participant list that leaves the viewer out or runs short, the name
 * stays. Attribution is the harmless side to err on. A name with no author id is still shown
 * (iOS does the same); with no name there is nothing to say.
 */
export function snippetAuthorLabel(
	conversation: SnippetFields,
	displayedTitle: string,
	selfId: string | undefined,
): string | null {
	if (selfId && conversation.snippet_actor_id === selfId) return 'You'
	const who = conversation.snippet_actor_name?.trim()
	if (!who) return null
	const isDirect =
		!!selfId &&
		conversation.participants.length === 2 &&
		conversation.participants.some((p) => p.actorId === selfId)
	return isDirect && sameName(who, displayedTitle) ? null : who
}

/**
 * A long name cut down to its initials for the chat list, which has no room for it: "Chief of
 * Staff" reads "CoS". Small words ("of", "the") keep their lower case, so the short form still
 * reads as the name. Names of one or two words ("Billing Agent") stay whole.
 */
export function shortActorName(name: string): string {
	const trimmed = name.trim()
	const words = trimmed.split(/\s+/).map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
	if (words.length < 3 || words.some((word) => !word)) return trimmed
	return words.map((word) => word.charAt(0)).join('')
}
