// How a `channel` value reads to a person; anything not listed is shown as its own words.
const CHANNEL_LABELS: Record<string, string> = {
	linkedin_dm: 'LinkedIn message',
	linkedin_message: 'LinkedIn message',
	linkedin_post: 'LinkedIn post',
	linkedin_connection_request: 'LinkedIn connection request',
	email: 'Email',
	slack: 'Slack',
	slack_dm: 'Slack message',
}

// Bookkeeping an agent files for itself: not something the reader needs on the card.
const HIDDEN_KEYS = new Set(['source', 'kind', 'previous_status', 'pending_draft'])

const MAX_VALUE_LENGTH = 60
const MAX_PROPERTIES = 4

/** What a card's preview block already shows, so the line of properties does not say it again. */
export interface ShownElsewhere {
	/** Names and addresses of the recipients the preview lists. */
	recipients: Array<string | null | undefined>
	/** The preview's own label ("LinkedIn message"), drawn in the card header. */
	label?: string | null
}

function same(a: string, b: string | null | undefined): boolean {
	return !!b && a.trim().toLowerCase() === b.trim().toLowerCase()
}

function humanize(value: string): string {
	const words = value.replace(/[_-]+/g, ' ').trim()
	return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The few properties of an object worth a line on its chat card, read from its metadata:
 * where it goes (`channel`, as "LinkedIn message") first, then short plain values such as a
 * priority or a recipient. Long text, empty values, lists and objects, internal keys
 * (a leading underscore) and the agent's own bookkeeping are left out. Nothing here is
 * specific to one agent or workflow: any object that carries a `channel` gets it shown.
 * With `shown`, a value the card already shows elsewhere (a recipient, the preview's label) is
 * left out so it reads once.
 */
export function describeObjectProperties(metadata: unknown, shown?: ShownElsewhere): string[] {
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return []
	const entries = Object.entries(metadata as Record<string, unknown>).filter(
		([key]) => !key.startsWith('_') && !HIDDEN_KEYS.has(key),
	)
	const lines: string[] = []
	// The channel leads: it says what kind of thing the object is about.
	const channel = entries.find(([key]) => key === 'channel')?.[1]
	if (typeof channel === 'string' && channel.trim()) {
		const line = CHANNEL_LABELS[channel.trim()] ?? humanize(channel)
		if (!same(line, shown?.label)) lines.push(line)
	}
	for (const [key, value] of entries) {
		if (key === 'channel') continue
		if (typeof value === 'number' || typeof value === 'boolean') {
			lines.push(`${humanize(key)}: ${value}`)
		} else if (typeof value === 'string') {
			const text = value.trim()
			if (shown?.recipients.some((recipient) => same(text, recipient))) continue
			if (text && text.length <= MAX_VALUE_LENGTH && !text.includes('\n')) {
				// A short code like "P1" reads as itself; a word reads as a label.
				lines.push(/^[A-Z]\d+$/.test(text) ? text : `${humanize(key)}: ${text}`)
			}
		}
	}
	return lines.slice(0, MAX_PROPERTIES)
}
