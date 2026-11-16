/**
 * The filters the chat list's search understands, read out of what the person typed.
 *
 *   agent:name   a chat an agent with that name is in
 *   from:name    a chat that person or agent has written in (me, agent and human also work)
 *   with:name    a chat that person or agent is in
 *   team:name    a chat tagged with that team
 *   is:value     unread, needs, working, later or archived
 *   "a phrase"   the exact words must appear
 *   -word        the word must not appear (also -"a phrase")
 *
 * Nothing else is special. A word with an unknown key (10:30, foo:bar) or an unknown is: value is
 * plain text, so typing a time or a link still finds chats. The text left over after the filters
 * is read by the normal search. The parser only reads: the server applies the filters, and a client
 * can use it to say which filters a search used (never the text itself).
 */

export const CHAT_SEARCH_IS_VALUES = ['unread', 'needs', 'working', 'later', 'archived'] as const
export type ChatSearchIsValue = (typeof CHAT_SEARCH_IS_VALUES)[number]

/** The fixed list the chat_list_search_used event names. */
export const CHAT_SEARCH_OPERATORS = [
	'agent',
	'from',
	'with',
	'team',
	'is',
	'phrase',
	'exclude',
] as const
export type ChatSearchOperator = (typeof CHAT_SEARCH_OPERATORS)[number]

/** Most values read per filter, so a pasted wall of text cannot build an enormous query. */
export const CHAT_SEARCH_MAX_PER_FILTER = 5

export interface ParsedChatSearch {
	/** What is left for the normal word search, single spaces between words. */
	text: string
	agent: string[]
	from: string[]
	with: string[]
	team: string[]
	is: ChatSearchIsValue[]
	phrases: string[]
	exclude: string[]
	/** The distinct filters used, in the fixed order above. Empty when none. */
	operators: ChatSearchOperator[]
}

const TOKEN = /(-)?(?:([A-Za-z]+):)?(?:"([^"]*)"|(\S+))/g

const VALUE_KEYS = ['agent', 'from', 'with', 'team'] as const
type ValueKey = (typeof VALUE_KEYS)[number]

function isValueKey(key: string): key is ValueKey {
	return (VALUE_KEYS as readonly string[]).includes(key)
}

function isIsValue(value: string): value is ChatSearchIsValue {
	return (CHAT_SEARCH_IS_VALUES as readonly string[]).includes(value)
}

export function parseChatSearch(q: string | undefined | null): ParsedChatSearch {
	const out: ParsedChatSearch = {
		text: '',
		agent: [],
		from: [],
		with: [],
		team: [],
		is: [],
		phrases: [],
		exclude: [],
		operators: [],
	}
	const words: string[] = []
	const push = <T>(list: T[], value: T) => {
		if (list.length < CHAT_SEARCH_MAX_PER_FILTER && !list.includes(value)) list.push(value)
	}

	for (const match of (q ?? '').matchAll(TOKEN)) {
		const [raw, minus, rawKey, quoted, bare] = match
		const key = rawKey?.toLowerCase()
		const value = (quoted ?? bare ?? '').trim()

		if (!minus && key && value) {
			if (isValueKey(key)) {
				push(out[key], value.toLowerCase())
				continue
			}
			if (key === 'is' && isIsValue(value.toLowerCase())) {
				push(out.is, value.toLowerCase() as ChatSearchIsValue)
				continue
			}
		}
		// A filter name with a minus or an unknown key is plain text: keep it as typed.
		if (key) {
			words.push(minus ? raw.slice(1) : raw)
			continue
		}
		if (quoted !== undefined) {
			if (value) push(minus ? out.exclude : out.phrases, value.toLowerCase())
			continue
		}
		if (minus && value) {
			push(out.exclude, value.toLowerCase())
			continue
		}
		words.push(raw)
	}

	out.text = words.join(' ')
	if (out.agent.length) out.operators.push('agent')
	if (out.from.length) out.operators.push('from')
	if (out.with.length) out.operators.push('with')
	if (out.team.length) out.operators.push('team')
	if (out.is.length) out.operators.push('is')
	if (out.phrases.length) out.operators.push('phrase')
	if (out.exclude.length) out.operators.push('exclude')
	return out
}
