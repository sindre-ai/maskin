/**
 * Detects a turn whose final text is the model *describing* tool calls instead
 * of making them.
 *
 * A model that fails to emit a real tool-call block sometimes serialises its
 * intent as prose wrapped in invented XML-ish tags, and the CLI closes the turn
 * with that as the reply. It is not an error — `is_error` is false, the turn
 * "succeeded" — so nothing upstream catches it and the finalizer posts it into
 * a human's chat verbatim. Observed 2026-08-31 in Mesh Firm, where a turn
 * routed to a fallback model closed with 74 `<skill_called>` tags
 * narrating a `get_session` call it never made, its own inner monologue
 * ("no wait, that was the read-only one"), and the agent's container path.
 *
 * The response is to nudge the model rather than to scrub the text: stripping
 * the markup would post whatever prose survived it, which is a reply the agent
 * never finished writing and whose tool calls still have not run. See
 * `InteractiveTurnFinalizer`.
 */

/**
 * Tag names that are pseudo-tool-call markup wherever they appear.
 *
 * All are inventions of a model imitating a tool-call channel — none is real
 * syntax any client renders, and none has an innocent meaning in prose. Add to
 * this list only for tags with that same property: a tag a human might
 * plausibly type (`<code>`, `<pre>`) belongs nowhere near it.
 */
const PSEUDO_TOOL_CALL_TAGS: readonly string[] = [
	'skill_called',
	'tool_call',
	'tool_use',
	'function_call',
	'function_calls',
	// Bare `invoke` alongside the namespaced form: a model imitating the
	// Anthropic tool-call format emits `<invoke name="...">` nested inside
	// `<function_calls>`, without the prefix.
	'invoke',
	'antml:invoke',
	'antml:function_calls',
]

/**
 * Matches an opening, closing, or self-closing tag from the list above, with
 * or without attributes. Built from the tag list so the two cannot drift.
 */
const PSEUDO_TOOL_CALL_TAG_RE = new RegExp(
	`</?(?:${PSEUDO_TOOL_CALL_TAGS.map((tag) => tag.replace(':', '\\:')).join('|')})(?:\\s[^>]*?)?/?>`,
	'gi',
)

/**
 * How many tag occurrences before a message is even a candidate.
 *
 * One or two tags is far more likely to be someone talking *about* the syntax
 * — a developer agent explaining a tool-call format, a bug report quoting one —
 * than a model losing the channel, and a false nudge costs a real reply. The
 * genuine failures come in floods; the observed one carried 74.
 */
const MIN_TAG_OCCURRENCES = 3

/**
 * The most surviving prose, as a share of the message, that still counts as a
 * lost turn.
 *
 * Prose is measured OUTSIDE the span from the first tag to the last, because
 * everything between them is the model narrating calls it never made — text
 * that looks like content and is worth nothing. Measuring the tags alone would
 * invert the test: the more the model rambled between them, the more it would
 * read as a real answer.
 *
 * The observed failure left 1.4% (one sentence, "Past the timeout window —
 * checking status."). A genuine answer that quotes tags in passing keeps most
 * of itself outside their span and posts normally.
 */
const MAX_SURVIVING_PROSE_SHARE = 0.25

/**
 * The shortest gap BETWEEN two tags that counts as surviving prose rather than
 * narration glue.
 *
 * Measuring outside the first..last span is what stops a rambling model from
 * reading as a real answer, but on its own it throws away a genuine reply that
 * quotes a tag in its opening line and again in its closing one: everything
 * real sits between the two, so the message scores as ~0% surviving and is
 * withheld entirely. Observed with a 2,400-character answer carrying three tags.
 *
 * A gap this long is a paragraph the human would lose, not the blank lines and
 * half-sentences that separate a flood of invented calls — the observed failure's
 * inter-tag gaps were blank lines. Counting only gaps over this length keeps the
 * original property (rambling between tags buys no pass) while a substantive
 * block of content does.
 */
const MIN_INTERLEAVED_PROSE_RUN = 400

export type PseudoToolCallVerdict = {
	/** True when the turn should be nudged instead of posted. */
	detected: boolean
	/** Tag occurrences found — carried into the log line, not into the chat. */
	occurrences: number
	/** Distinct tag names found, for the same reason. */
	tags: string[]
}

/**
 * Decide whether a turn's final text is pseudo-tool-call markup rather than a
 * reply.
 *
 * Conservative on both axes: a message must carry several tags AND be almost
 * entirely inside their span. Thresholds favour posting when unsure — but note
 * that a false positive here is recoverable in a way that dropping the message
 * would not be, since the caller's response is to ask the model to answer
 * again rather than to discard the turn.
 */
export function detectPseudoToolCalls(text: string): PseudoToolCallVerdict {
	// `matchAll` rather than `match`: the offsets are needed to find the span,
	// and a /g regex is stateful, so sharing one across calls via `.test`/
	// `.exec` would make the result depend on the previous invocation.
	const matches = [...text.matchAll(PSEUDO_TOOL_CALL_TAG_RE)]
	const occurrences = matches.length
	if (occurrences < MIN_TAG_OCCURRENCES) return { detected: false, occurrences, tags: [] }

	const tags = [
		...new Set(
			matches.map(
				(match) =>
					match[0].replace(/^<\/?/, '').replace(/\/?>$/, '').split(/\s/)[0]?.toLowerCase() ?? '',
			),
		),
	]
		.filter(Boolean)
		.sort()

	const trimmedLength = text.trim().length
	if (trimmedLength === 0) return { detected: false, occurrences, tags }

	const first = matches[0]
	const last = matches[occurrences - 1]
	if (first?.index === undefined || last?.index === undefined) {
		return { detected: false, occurrences, tags }
	}

	const before = text.slice(0, first.index)
	const after = text.slice(last.index + last[0].length)
	let survivingProse = `${before} ${after}`.trim().length

	// Plus any gap between two tags long enough to be real content rather than
	// glue. Without this, a genuine answer bracketed by tag quotes measures as
	// having survived nothing and is withheld from the human entirely.
	for (let i = 0; i < occurrences - 1; i++) {
		const current = matches[i]
		const next = matches[i + 1]
		if (current?.index === undefined || next?.index === undefined) continue
		const gap = text.slice(current.index + current[0].length, next.index).trim().length
		if (gap >= MIN_INTERLEAVED_PROSE_RUN) survivingProse += gap
	}

	return {
		detected: survivingProse <= MAX_SURVIVING_PROSE_SHARE * trimmedLength,
		occurrences,
		tags,
	}
}
