/**
 * The weekly capability note, written by template. No model, no description, no
 * url: the builder takes whitelisted fields only (integration display name, tool
 * names, agent display names that already passed the visibility filter, scope
 * names) and cleans every one of them before it reaches the text.
 *
 * The note never carries an approval, a spend or a risk call, never a decision
 * block, and never says grant or attach. An integration nobody can use is
 * reported as connected, with the decision left to an admin.
 */

export const NOTE_MAX_CHARS = 900
export const NOTE_MAX_ITEMS = 5

const NAME_MAX = 40
const TOOLS_SHOWN = 3
const AGENTS_SHOWN = 3
const SCOPES_SHOWN = 2

export type NoteItem =
	| { kind: 'new_tools'; integration: string; tools: string[]; agents: string[] }
	| { kind: 'needs_reconnect'; integration: string; scopes: string[] }
	| { kind: 'not_attached'; integration: string }

export interface BuiltNote {
	content: string
	/** Items written out. At most NOTE_MAX_ITEMS. */
	shown: number
	/** Items left out, reported as "and N more". */
	hidden: number
}

/** Plain text only: no backticks, no long dashes, no line breaks, bounded length. */
export function cleanText(value: string, max = NAME_MAX): string {
	return value
		.replace(/[`\u2013\u2014]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max)
}

/** A scope arrives as a full name or a url; only its last readable segment is shown. */
export function scopeLabel(scope: string): string {
	const last = scope.split(/[/:]/).filter(Boolean).pop() ?? scope
	const label = cleanText(last.replace(/[^A-Za-z0-9_.-]/g, ''))
	return label.split('.').pop() || label
}

function joinList(names: string[], shown: number): string {
	if (names.length === 0) return ''
	const head = names.slice(0, shown)
	const rest = names.length - head.length
	if (rest > 0) return `${head.join(', ')} and ${rest} more`
	if (head.length === 1) return head[0] as string
	return `${head.slice(0, -1).join(', ')} and ${head[head.length - 1]}`
}

/** Tool names in brackets read as a plain comma list: a, b, c and 2 more. */
function toolList(names: string[]): string {
	const head = names.slice(0, TOOLS_SHOWN)
	const rest = names.length - head.length
	return rest > 0 ? `${head.join(', ')} and ${rest} more` : head.join(', ')
}

function newToolsSentence(item: Extract<NoteItem, { kind: 'new_tools' }>): string {
	const count = item.tools.length
	const noun = count === 1 ? 'tool' : 'tools'
	const them = count === 1 ? 'it' : 'them'
	const tools = toolList(item.tools.map((t) => cleanText(t, NAME_MAX)))
	const agents = joinList(
		item.agents.map((a) => cleanText(a, NAME_MAX)),
		AGENTS_SHOWN,
	)
	return `${cleanText(item.integration)} has ${count} new ${noun} (${tools}), and ${agents} can use ${them}.`
}

function reconnectSentence(item: Extract<NoteItem, { kind: 'needs_reconnect' }>): string {
	const scopes = item.scopes.map(scopeLabel).filter(Boolean)
	const name = cleanText(item.integration)
	if (scopes.length === 0) return `${name} wants a reconnect before the new tools work.`
	const list = joinList(scopes, SCOPES_SHOWN)
	return scopes.length === 1
		? `${name} wants a reconnect before the new ${list} scope works.`
		: `${name} wants a reconnect before the new ${list} scopes work.`
}

function render(firstName: string, items: NoteItem[], hidden: number): string {
	const parts = [`Hey ${cleanText(firstName) || 'there'}, quick check on what your agents can do.`]

	const fresh = items.filter(
		(i): i is Extract<NoteItem, { kind: 'new_tools' }> => i.kind === 'new_tools',
	)
	if (fresh.length > 0) parts.push(`New this week: ${fresh.map(newToolsSentence).join(' ')}`)

	const reconnect = items.filter(
		(i): i is Extract<NoteItem, { kind: 'needs_reconnect' }> => i.kind === 'needs_reconnect',
	)
	if (reconnect.length > 0) parts.push(`Needs you: ${reconnect.map(reconnectSentence).join(' ')}`)

	const unused = items.filter((i) => i.kind === 'not_attached')
	if (unused.length > 0) {
		const lines = unused
			.map(
				(i) => `${cleanText(i.integration)} is connected but none of your agents can use it yet.`,
			)
			.join(' ')
		parts.push(
			`Also: ${lines} An admin decides whether any agent gets ${unused.length === 1 ? 'it' : 'them'}.`,
		)
	}

	if (hidden > 0) parts.push(`And ${hidden} more.`)
	parts.push(
		'Reply "tell me more" and I will go through any of it. Reply "stop" and I will not send these.',
	)
	return parts.join(' ')
}

/**
 * Writes the note. Items are taken in the order given (new tools, then
 * reconnects, then unused integrations); the first five are shown and the rest
 * become "and N more". If the text is still over the character limit, items
 * are dropped from the end until it fits.
 */
export function buildCapabilityNote(input: { firstName: string; items: NoteItem[] }): BuiltNote {
	const ordered = [...input.items].sort((a, b) => order(a) - order(b))
	let shown = Math.min(ordered.length, NOTE_MAX_ITEMS)
	let content = render(input.firstName, ordered.slice(0, shown), ordered.length - shown)
	while (content.length > NOTE_MAX_CHARS && shown > 1) {
		shown--
		content = render(input.firstName, ordered.slice(0, shown), ordered.length - shown)
	}
	return { content, shown, hidden: ordered.length - shown }
}

function order(item: NoteItem): number {
	return item.kind === 'new_tools' ? 0 : item.kind === 'needs_reconnect' ? 1 : 2
}
