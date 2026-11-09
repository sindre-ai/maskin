import type { ConversationListItemResponse } from '@/lib/api'

type SnippetFields = Pick<
	ConversationListItemResponse,
	'title' | 'participants' | 'snippet_actor_id' | 'snippet_actor_name'
>

/**
 * Who a chat row's preview names, or null when it should not say. The one place this is decided
 * (the iOS twin is `ConversationSummary.snippetAuthorLead`).
 *
 * The viewer reads as "You". Anyone else is named, except when the name would only repeat the row
 * title: a two-person chat titled with the other person's name ("Bookkeeper" / "Bookkeeper: Hey…").
 * A custom title ("Q3 planning"), three or more people, or no participant list keep the name:
 * attribution is the harmless side to err on.
 */
export function snippetAuthorLabel(
	conversation: SnippetFields,
	selfId: string | undefined,
): string | null {
	if (!conversation.snippet_actor_id) return null
	if (conversation.snippet_actor_id === selfId) return 'You'
	const who = conversation.snippet_actor_name?.trim()
	if (!who) return null
	const repeatsTitle =
		conversation.participants.length === 2 &&
		who.toLowerCase() === conversation.title.trim().toLowerCase()
	return repeatsTitle ? null : who
}
