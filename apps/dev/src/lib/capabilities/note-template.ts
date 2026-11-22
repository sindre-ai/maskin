/**
 * The weekly capability note, written by template. No model, no description, no
 * url: the builder takes whitelisted fields only (integration display name, tool
 * names, agent display names that already passed the visibility filter, scope
 * names) and cleans every one of them before it reaches the text.
 *
 * It says what a person can now get done, one sentence per app, and never a
 * tool name: a tool name is turned into plain words before it is shown.
 *
 * The note never carries an approval, a spend or a risk call, never a decision
 * block, and never says grant or attach. An integration nobody can use is
 * reported as connected, with the decision left to an admin.
 */

export const NOTE_MAX_CHARS = 900
export const NOTE_MAX_ITEMS = 3

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

/**
 * A tool name as plain words: "slack_react" under Slack becomes "react". The
 * integration name is dropped when the tool name starts with it, and every
 * separator becomes a space, so no snake_case reaches the person.
 */
export function toolPhrase(tool: string, integration: string): string {
	const last = tool.split('__').filter(Boolean).pop() ?? tool
	const words = last
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((w) => w.toLowerCase())
	const app = cleanText(integration)
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
	const trimmed =
		app.length > 0 && app.every((w, i) => words[i] === w) ? words.slice(app.length) : words
	return cleanText((trimmed.length > 0 ? trimmed : words).join(' '))
}

/** Actions as a plain list: react, pin and 2 other things. */
function actionList(phrases: string[]): string {
	const unique = [...new Set(phrases.filter(Boolean))]
	const head = unique.slice(0, TOOLS_SHOWN)
	const rest = unique.length - head.length
	const base =
		head.length > 1
			? `${head.slice(0, -1).join(', ')} and ${head[head.length - 1]}`
			: (head[0] ?? '')
	if (rest <= 0) return base
	return `${head.join(', ')} and ${rest} other ${rest === 1 ? 'thing' : 'things'}`
}

function newToolsSentence(item: Extract<NoteItem, { kind: 'new_tools' }>): string {
	const actions = actionList(item.tools.map((t) => toolPhrase(t, item.integration)))
	const agents = joinList(
		item.agents.map((a) => cleanText(a, NAME_MAX)),
		AGENTS_SHOWN,
	)
	return `Your ${agents} can now ${actions} in ${cleanText(item.integration)}.`
}

function reconnectSentence(item: Extract<NoteItem, { kind: 'needs_reconnect' }>): string {
	const scopes = item.scopes.map(scopeLabel).filter(Boolean)
	const name = cleanText(item.integration)
	if (scopes.length === 0)
		return `${name} needs a reconnect before your agents can use what is new.`
	return `${name} needs a reconnect before your agents can use the new ${joinList(scopes, SCOPES_SHOWN)} access.`
}

function render(firstName: string, items: NoteItem[], hidden: number): string {
	const parts = [`Hey ${cleanText(firstName) || 'there'}, here is what your agents can now do.`]

	const fresh = items.filter(
		(i): i is Extract<NoteItem, { kind: 'new_tools' }> => i.kind === 'new_tools',
	)
	if (fresh.length > 0) parts.push(fresh.map(newToolsSentence).join(' '))

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
