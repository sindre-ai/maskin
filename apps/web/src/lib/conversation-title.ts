/** Longest title we keep intact; past this the title is cut on a word boundary. */
const MAX_TITLE_LENGTH = 72
/** Below this a word-boundary cut would leave a stub, so we cut mid-word instead. */
const MIN_WORD_BOUNDARY = 40

/**
 * Titles a conversation from its first message, the way the mockup's chat list
 * reads ("Which accounts went quiet this week?", "Why did trial signups dip
 * last week?") — the topic, not the participants.
 *
 * Every entry point that starts a conversation used to title it either by the
 * agent's name (so every thread with the same agent shared one title) or by a
 * blind `slice(0, 60)` (so a title could end mid-word with no ellipsis). Both
 * are replaced by this: the first sentence of the message, trimmed to a word
 * boundary when it runs long.
 *
 * This is a deterministic local derivation, not a model-written summary — a
 * long opening message still yields its first sentence rather than a précis.
 */
export function deriveConversationTitle(message: string, fallback: string): string {
	const cleaned = message.replace(/\s+/g, ' ').trim()
	if (cleaned.length === 0) return fallback

	// Up to and including the first sentence terminator. `[^.!?]+` can't match
	// the empty string, so a message that opens with punctuation falls through
	// to the whole cleaned string rather than producing an empty title.
	const sentence = cleaned.match(/^[^.!?]+[.!?]?/)?.[0]?.trim()
	const title = sentence && sentence.length > 0 ? sentence : cleaned
	if (title.length <= MAX_TITLE_LENGTH) return title

	const cut = title.slice(0, MAX_TITLE_LENGTH)
	const lastSpace = cut.lastIndexOf(' ')
	const base = lastSpace >= MIN_WORD_BOUNDARY ? cut.slice(0, lastSpace) : cut
	return `${base.trimEnd()}…`
}
