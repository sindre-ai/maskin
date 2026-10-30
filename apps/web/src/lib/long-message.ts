import { MESSAGE_MAX_LENGTH } from '@maskin/shared'

// How much of the typed text stays in the message body, so the chat shows
// what the message was about without the whole thing.
const PREVIEW_CHARS = 500

export interface LongMessageSplit {
	/** Short body that fits the chat message cap and points at the attachment. */
	body: string
	file: { name: string; content: string }
}

export function isOverMessageLimit(text: string): boolean {
	return text.length > MESSAGE_MAX_LENGTH
}

/**
 * Turns text over the chat message cap into a short readable body plus the
 * full text as a .txt attachment. Returns null when the text already fits.
 */
export function splitLongMessage(text: string, now: Date = new Date()): LongMessageSplit | null {
	if (!isOverMessageLimit(text)) return null
	const cut = text.slice(0, PREVIEW_CHARS)
	// Break on a space when there is one near the end, so a word is not cut in half.
	const lastSpace = cut.lastIndexOf(' ')
	const preview = (lastSpace > PREVIEW_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()
	const name = `message-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`
	return {
		body: `${preview}…\n\nThe full message (${text.length.toLocaleString('en-US')} characters) is attached as ${name}.`,
		file: { name, content: text },
	}
}
