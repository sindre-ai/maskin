import type { LatestMention, LatestMentionDecision, UnreadItem } from '@/lib/api'

// The two action-UI weights a For You card renders.
// - `decision` → the agent asked for a call, and authored the options
// - `thread`   → a plain mention with no decision attached; composer only
//
// This used to be four kinds inferred from the object's own type and status
// (`task` + `in_review` → decision, and so on), paired with a hardcoded
// CARD_ACTIONS registry that invented "Approve / Send back" for every card and
// marked one of them recommended on no evidence. Both are gone: an ask is a
// decision when the agent said it was, and its options are the ones the agent
// wrote.

export type CardKind = 'decision' | 'thread'

export interface CardAction {
	// Stable id emitted as `action_id` on `foryou_card_action`. Derived from the
	// label, since agent-authored options have no id of their own.
	id: string
	label: string
	// What taking this option means — the agent's own consequence lines, one
	// clause each, including the downside.
	consequences: readonly string[]
	// The option the agent would take. Exactly one per decision, enforced by the
	// API when the comment is posted.
	recommended?: boolean
}

/** Slug an option label into a stable analytics id: "7-day window" → `7_day_window`. */
export function actionIdFromLabel(label: string): string {
	return (
		label
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '') || 'option'
	)
}

/** The decision an agent attached to the comment behind this card, if any. */
export function decisionOf(item: UnreadItem): LatestMentionDecision | null {
	return item.latest_mention?.decision ?? null
}

export function classifyCardKind(item: UnreadItem): CardKind {
	return decisionOf(item) ? 'decision' : 'thread'
}

/**
 * The card's options, in render order. The recommended one sits last, where the
 * layout puts the filled bar.
 */
export function cardActions(item: UnreadItem): readonly CardAction[] {
	const decision = decisionOf(item)
	if (!decision) return []
	return decision.options
		.map((option) => ({
			id: actionIdFromLabel(option.label),
			label: option.label,
			consequences: option.consequences,
			recommended: option.recommended,
		}))
		.sort((a, b) => (a.recommended ? 1 : 0) - (b.recommended ? 1 : 0))
}

/** The option the agent recommends, for "take every suggested option". */
export function recommendedAction(item: UnreadItem): CardAction | undefined {
	const actions = cardActions(item)
	return actions.find((action) => action.recommended)
}

/**
 * What the card leads with. Every For You item exists because an agent
 * @-mentioned the reader, so the headline is that ask — the decision's title
 * when there is one, else the opening of the comment. The object's own title is
 * the last resort: it is identical across every mention on that object, so ten
 * different asks would otherwise read the same.
 */
export function cardHeadline(item: UnreadItem): string {
	const decision = decisionOf(item)
	if (decision?.title.trim()) return decision.title.trim()

	const { headline } = mentionParts(item.latest_mention)
	if (headline) return headline

	return item.object?.title?.trim() || 'Untitled'
}

/**
 * What the card renders under the headline for a mention with no decision:
 * everything the headline did not already take. Returning the whole comment
 * would print its opening twice.
 */
export function cardBody(item: UnreadItem): string {
	if (decisionOf(item)) return ''
	return mentionParts(item.latest_mention).body
}

// A headline is a headline, not the first paragraph. A decision's title is held
// to 3-7 words by the API, but a plain comment's opening was written as prose,
// so the card takes its first sentence and caps that rather than setting three
// sentences of welcome copy at headline weight.
const HEADLINE_MAX_WORDS = 9

/**
 * Splits a mention into the line the card sets as its headline and the body
 * under it. One function, so the two cannot disagree and print the same words
 * twice or drop the tail of a sentence the headline only partly used.
 */
function mentionParts(mention: LatestMention | undefined): { headline: string; body: string } {
	if (!mention) return { headline: '', body: '' }

	// Skip markdown scaffolding, so a comment opening with "## Heading" or
	// "- point" still yields prose.
	const lines = mention.content.split('\n')
	const leadIndex = lines.findIndex((raw) => stripMarkdownLead(raw))
	if (leadIndex === -1) return { headline: '', body: '' }

	const lead = stripMarkdownLead(lines[leadIndex] ?? '')
	const [sentence, rest] = firstSentence(lead)
	const headline = capWords(sentence)
	// A capped headline is an excerpt rather than the sentence, so the body keeps
	// that sentence whole — the reader never loses the half the headline cut.
	const under = headline === sentence ? rest : lead
	return { headline, body: [under, ...lines.slice(leadIndex + 1)].join('\n').trim() }
}

// The lead sentence, and whatever follows it on that line. A line with no
// terminator is all headline, and the word cap keeps it in bounds.
function firstSentence(line: string): [string, string] {
	const match = line.match(/^.*?[.!?](?=\s|$)/)
	if (!match) return [line, '']
	return [match[0].trim(), line.slice(match[0].length).trim()]
}

// Cuts an overlong opening rather than setting it at headline weight. The caller
// keeps the whole sentence in the body when this fires, so nothing is lost.
function capWords(value: string): string {
	const words = value.split(/\s+/).filter(Boolean)
	if (words.length <= HEADLINE_MAX_WORDS) return value
	return `${words.slice(0, HEADLINE_MAX_WORDS).join(' ')}…`
}

function stripMarkdownLead(raw: string): string {
	return raw.replace(/^\s*(?:[#>*-]+|\d+\.)\s*/, '').trim()
}
