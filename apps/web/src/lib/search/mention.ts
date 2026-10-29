// The @ menu in the search field: typing a word that starts with @ offers the
// workspace's people and agents, and picking one turns the typed @word into a
// participant pill (only chats that person or agent is in). Pure data in, plain
// data out. A leading @ that matches nobody offers nothing and stays plain text.

import { SEARCH_MAX_PARTICIPANTS } from '@maskin/shared'
import { type SearchParts, addPill, pillValues } from './parts'
import type { ParticipantOption } from './vocabulary'

/** Feature flag id (registered in FLAGS in apps/dev/src/lib/feature-flags.ts). */
export const PARTICIPANT_FILTER_FLAG = 'search-chat-participant-filter'

export const MAX_MENU_ROWS = 8

export interface Mention {
	/** Index of the @ in the text. */
	start: number
	/** What was typed after the @, to the end of the text. */
	query: string
}

/**
 * The last @ that begins a word, or null. The query runs to the end of the text, so a
 * name with a space in it ("@product marketing") keeps filtering as it is typed.
 */
export function findMention(text: string): Mention | null {
	const m = /(?:^|\s)@([^@]*)$/.exec(text)
	if (!m) return null
	return { start: m.index + m[0].length - m[1].length - 1, query: m[1] }
}

/**
 * The people and agents whose name contains the query, names that start with it first.
 * Already-picked actors are left out, and nothing is offered once the cap is reached.
 */
export function matchParticipants(
	options: Iterable<ParticipantOption>,
	query: string,
	picked: string[],
): ParticipantOption[] {
	if (picked.length >= SEARCH_MAX_PARTICIPANTS) return []
	const needle = query.trim().toLowerCase()
	const rank = (name: string) => (name.toLowerCase().startsWith(needle) ? 0 : 1)
	return [...options]
		.filter((o) => !picked.includes(o.id) && o.name.toLowerCase().includes(needle))
		.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
		.slice(0, MAX_MENU_ROWS)
}

/** The rows to show for the text as it stands; empty when there is no @word or nobody matches it. */
export function mentionRows(
	parts: SearchParts,
	options: Iterable<ParticipantOption>,
): ParticipantOption[] {
	const mention = findMention(parts.text)
	if (!mention) return []
	return matchParticipants(options, mention.query, pillValues(parts, 'participant'))
}

/**
 * Picking a row. The @word leaves the text and a participant pill takes its place.
 * The pill keeps no typed word: removing it only drops the filter, so the menu does
 * not pop open again.
 */
export function pickParticipant(parts: SearchParts, id: string): SearchParts {
	const mention = findMention(parts.text)
	if (!mention) return parts
	return addPill(
		{ ...parts, text: parts.text.slice(0, mention.start) },
		{ kind: 'participant', value: id },
	)
}
