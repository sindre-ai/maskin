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
//
// A `thread` card can still carry buttons: comments written before the decision
// block existed put their options in `metadata.chips`, and those are
// agent-authored too, so rendering them invents nothing. They stay `thread`
// because the agent did not author a decision, and a chip carries no
// consequences and no recommendation.
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
 *
 * Falls back to the comment's legacy `metadata.chips` when there is no decision
 * block, so a pre-decision ask still renders as buttons rather than as prose the
 * reader has to answer by hand. A chip is a bare label: no consequence lines, and
 * no recommendation, so no option gets the filled bar.
 */
export function cardActions(item: UnreadItem): readonly CardAction[] {
	const decision = decisionOf(item)
	if (!decision) {
		return (item.latest_mention?.chips ?? []).map((chip) => ({
			id: actionIdFromLabel(chip),
			label: chip,
			consequences: [],
		}))
	}
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
 * when there is one, else the comment's opening line. The object's own title is
 * the last resort: it is identical across every mention on that object, so ten
 * different asks would otherwise read the same.
 */
export function cardHeadline(item: UnreadItem): string {
	const decision = decisionOf(item)
	if (decision?.title.trim()) return decision.title.trim()

	const firstLine = firstMeaningfulLine(item.latest_mention)
	if (firstLine) return firstLine

	return item.object?.title?.trim() || 'Untitled'
}

/**
 * What the card renders under the headline for a mention with no decision.
 *
 * The headline is already the comment's opening line, so the body is what
 * follows it — returning the whole comment would print that line twice, which
 * for a one-line comment is the entire card duplicated.
 */
export function cardBody(item: UnreadItem): string {
	if (decisionOf(item)) return ''
	const mention = item.latest_mention
	if (!mention) return ''

	const lines = mention.content.split('\n')
	const headlineIndex = lines.findIndex((raw) => stripMarkdownLead(raw))
	if (headlineIndex === -1) return ''
	return lines
		.slice(headlineIndex + 1)
		.join('\n')
		.trim()
}

// The opening line of a comment body, skipping markdown scaffolding so a
// comment that starts with "## Heading" or "- point" still yields prose.
function firstMeaningfulLine(mention: LatestMention | undefined): string {
	if (!mention) return ''
	for (const raw of mention.content.split('\n')) {
		const line = stripMarkdownLead(raw)
		if (line) return line
	}
	return ''
}

function stripMarkdownLead(raw: string): string {
	return raw.replace(/^\s*(?:[#>*-]+|\d+\.)\s*/, '').trim()
}
