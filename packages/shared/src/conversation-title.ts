/**
 * Deterministic first-sentence extractor for conversation titles. Same logic
 * runs on the frontend (before create-conversation calls) and the backend
 * (auto-titler fallback when the LLM path can't produce a title), so a
 * placeholder like "New chat" never survives on either side.
 */

/** Longest title we keep intact; past this the title is cut on a word boundary. */
const MAX_TITLE_LENGTH = 72
/** Below this a word-boundary cut would leave a stub, so we cut mid-word instead. */
const MIN_WORD_BOUNDARY = 40
/**
 * Shorter than this, a "sentence" is almost certainly an abbreviation we cut on
 * by mistake ("Dr.", "e.g.") rather than a real one, so we keep the whole
 * message instead of titling a chat `Dr.`.
 */
const MIN_SENTENCE_LENGTH = 12

/**
 * Matches up to and including the first sentence terminator that is actually
 * ending a sentence — one followed by whitespace or the end of the message.
 * Requiring the space is what keeps decimals and URLs intact: the `.` in
 * `3.5` or `acme.com` is followed by a character, so it never terminates.
 * Abbreviations ("Dr. Ruiz") do pass this test and are caught by
 * MIN_SENTENCE_LENGTH below.
 *
 * `cleaned` has had its whitespace collapsed before this runs, so it holds no
 * newlines and `.` matches every character in it.
 */
const FIRST_SENTENCE = /^.*?[.!?](?=\s|$)/

/**
 * Titles a conversation from its first message, the way the mockup's chat list
 * reads ("Which accounts went quiet this week?", "Why did trial signups dip
 * last week?") — the topic, not the participants.
 *
 * This is a deterministic local derivation, not a model-written summary — a
 * long opening message still yields its first sentence rather than a précis.
 * Both the frontend composer and the backend auto-titler use it: the frontend
 * so a new conversation carries a real title from the moment it lands, the
 * backend so the LLM-less path still ends up with a content-derived title
 * instead of the placeholder the frontend passed as a fallback.
 */
export function deriveConversationTitle(message: string, fallback: string): string {
	const cleaned = message.replace(/\s+/g, ' ').trim()
	if (cleaned.length === 0) return fallback

	// A sentence too short to be one is discarded rather than shipped, so the
	// title falls through to the whole (length-capped) message.
	const sentence = cleaned.match(FIRST_SENTENCE)?.[0]?.trim()
	const title = sentence && sentence.length >= MIN_SENTENCE_LENGTH ? sentence : cleaned
	if (title.length <= MAX_TITLE_LENGTH) return title

	const cut = title.slice(0, MAX_TITLE_LENGTH)
	const lastSpace = cut.lastIndexOf(' ')
	const base = lastSpace >= MIN_WORD_BOUNDARY ? cut.slice(0, lastSpace) : cut
	return `${base.trimEnd()}…`
}
