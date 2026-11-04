/**
 * Deterministic topic extractor for conversation titles. Same logic runs on the
 * frontend (before create-conversation calls) and the backend (auto-titler
 * fallback when the LLM path can't produce a title), so a placeholder like
 * "New chat" never survives on either side and both sides write the same title.
 */

/** Longest title we keep intact; past this the title is cut on a word boundary. */
const MAX_TITLE_LENGTH = 32
/** Below this a word-boundary cut would leave a stub, so we cut mid-word instead. */
const MIN_WORD_BOUNDARY = 18
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

/** A topic title keeps at most this many words. */
const MAX_TOPIC_WORDS = 5
/** Fewer keywords than this is not a topic, so the first-sentence cut is used. */
const MIN_TOPIC_WORDS = 3

/** Request phrasing ("Please review the...", "Can you...") dropped from the start only. */
const OPENERS = new Set(
	'please pls hey hi hello can could would will you i we want need like to lets let us me help review check look take write draft create make give show tell explain find update'.split(
		' ',
	),
)
const CLAUSE_BREAKS = new Set(['and', 'or', 'but'])
/** Words that carry no topic, dropped wherever they appear. */
const STOPWORDS = new Set(
	'a an the to of before after for in on at by with from into about and or but is are was were be been this that these those it its my our your me us you i we their which what who how why when where do does did has have had as if so then there'.split(
		' ',
	),
)

/**
 * "Please review the scope of the YouTube integration" -> "Scope YouTube
 * integration": request phrasing and filler words removed, the rest kept in
 * order. Returns null when too little is left to read as a topic.
 */
function topicTitle(text: string): string | null {
	const words = text
		.split(' ')
		.map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
		.filter(Boolean)
	let start = 0
	while (
		start < words.length &&
		OPENERS.has((words[start] ?? '').toLowerCase().replace(/[’']/g, ''))
	)
		start++

	const kept: string[] = []
	let length = 0
	for (const word of words.slice(start)) {
		const lower = word.toLowerCase()
		// A conjunction after enough keywords starts a second request ("... and tell me").
		if (CLAUSE_BREAKS.has(lower) && kept.length >= MIN_TOPIC_WORDS) break
		if (STOPWORDS.has(lower)) continue
		length += word.length + (kept.length ? 1 : 0)
		if (kept.length >= MAX_TOPIC_WORDS || length > MAX_TITLE_LENGTH) break
		kept.push(word)
	}
	if (kept.length < MIN_TOPIC_WORDS) return null
	const title = kept.join(' ')
	return title.charAt(0).toUpperCase() + title.slice(1)
}

/**
 * Titles a conversation from its first message by topic, not by its opening
 * words, and never by the participants.
 *
 * This is a deterministic local derivation, not a model-written summary: the
 * keywords of the first sentence, in order. A message with too few keywords
 * falls back to the first sentence itself. Both the frontend composer and the backend auto-titler use it: the frontend
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
	const topic = topicTitle(sentence && sentence.length >= MIN_SENTENCE_LENGTH ? sentence : cleaned)
	if (topic) return topic
	const title = sentence && sentence.length >= MIN_SENTENCE_LENGTH ? sentence : cleaned
	if (title.length <= MAX_TITLE_LENGTH) return title

	const cut = title.slice(0, MAX_TITLE_LENGTH)
	const lastSpace = cut.lastIndexOf(' ')
	const base = lastSpace >= MIN_WORD_BOUNDARY ? cut.slice(0, lastSpace) : cut
	return `${base.trimEnd()}…`
}
