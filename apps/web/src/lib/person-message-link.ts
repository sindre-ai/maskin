/**
 * Which Message button opened New chat. The value is also the `entry_point` that
 * `chat_session_started` carries, so the row icon and the page button can be told apart.
 */
export type PersonMessageSource = 'person_message_row' | 'person_message_page'

export const PERSON_MESSAGE_SOURCES: readonly PersonMessageSource[] = [
	'person_message_row',
	'person_message_page',
]

/** Navigation target for a Message button: New chat with the person already in "To". */
export function personMessageLink(
	workspaceId: string,
	person: { id: string; name: string },
	source: PersonMessageSource,
) {
	return {
		to: '/$workspaceId/chats/new' as const,
		params: { workspaceId },
		// `agentId` is named for agents but seeds any actor id.
		search: { agentId: person.id, agentName: person.name, from: source },
	}
}
