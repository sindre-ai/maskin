import type { UnreadItem } from '@/lib/api'

// The three action-UI weights the For You redesign renders per card.
// - `decision`  → shaded footer with full-width primary/secondary buttons (heavier stakes)
// - `sign_off`  → flat chip-row in the body (lighter — approve/send back)
// - `proposed_bet` → flat chip-row in the body (lighter — open/refine/dismiss)
// - `first_use` → the Research Agent's context card, same weight as `decision`
// - `thread`    → fallback for anything that isn't decision-shaped (regular reply chips)
export type CardKind = 'decision' | 'first_use' | 'sign_off' | 'proposed_bet' | 'thread'

// The first-use conversation cards. `context` — the researched Knowledge the
// Research Agent wants confirmed before every agent inherits it — is the only
// one carrying a decision; the introduction and suggestions cards are threads
// whose quick replies come from the comment's own `metadata.chips`.
const FIRST_USE_SESSION_TYPE = 'onboarding_session'
const FIRST_USE_DECISION_CARD = 'context'

// Statuses that signal a bet is a proposed/early-stage bet (not yet shaped).
// A bet in one of these needs a "yes / refine / dismiss" call, not an approval.
const PROPOSED_BET_STATUSES = new Set(['signal', 'proposed', 'define', 'clustered'])

// A task waiting on review can be either a bet-level decision the human owns
// (Design/Architecture/Copy — tagged `metadata.decision_type`) or an agent
// asking for a light-touch sign-off. `in_review` is the only task status the
// workspace schema exposes for either — the `decision_type` metadata is what
// splits the two. Bets themselves have no `in_review` status (see the API
// error the parent bet-qa surfaced), so `decision` never keys off `bet.status`.
const REVIEW_TASK_STATUSES = new Set(['in_review'])

function hasDecisionType(item: UnreadItem): boolean {
	const decisionType = item.object?.metadata?.decision_type
	return typeof decisionType === 'string' && decisionType.length > 0
}

export function classifyCardKind(item: UnreadItem): CardKind {
	const type = item.object?.type
	const status = item.object?.status
	if (type === FIRST_USE_SESSION_TYPE) {
		return item.object?.metadata?.first_use_card === FIRST_USE_DECISION_CARD
			? 'first_use'
			: 'thread'
	}
	if (!type || !status) return 'thread'
	if (type === 'task' && REVIEW_TASK_STATUSES.has(status)) {
		return hasDecisionType(item) ? 'decision' : 'sign_off'
	}
	if (type === 'bet' && PROPOSED_BET_STATUSES.has(status)) return 'proposed_bet'
	return 'thread'
}

export interface CardAction {
	// Stable id T6 emits as `action_id` on `foryou_card_action`.
	id: string
	// User-facing label.
	label: string
	// Primary shows filled/dark; secondary shows outline/light.
	tone: 'primary' | 'secondary'
	// One-line rationale under the label on the in-stream AskCard's option rows.
	// Only the decision actions carry one; sign_off / proposed_bet / quick-reply
	// stay chip-shaped with no rationale.
	rationale?: string
	// Marks the option the card recommends — rendered as the mockup's `REC`
	// chip (mockup 419–424). It is a property of the *action registry* below,
	// the same static class of data as `label` and `rationale`; no per-item
	// recommendation is computed from the object, and nothing in the API
	// returns one, so exactly one option per kind carries it.
	recommended?: boolean
}

// Kind → ordered list of affordances. First is always the primary action.
// Labels match the Designer's prototype (foryou-directions-A-B.html).
export const CARD_ACTIONS: Record<Exclude<CardKind, 'thread'>, readonly CardAction[]> = {
	// First use asks one question the agent genuinely cannot answer for itself:
	// is the context it researched right? The three options are the three things
	// that actually change what happens next — confirm it, send it back for a
	// rewrite, or point it at more material.
	first_use: [
		{
			id: 'context_confirmed',
			label: 'Looks right',
			tone: 'primary',
			rationale: 'Every agent starts from it as written',
		},
		{
			id: 'context_wrong',
			label: 'Something is wrong',
			tone: 'secondary',
			rationale: 'The Research Agent rewrites it — the old version stays in history',
		},
		{
			id: 'context_add_source',
			label: 'Add a source',
			tone: 'secondary',
			rationale: 'Name what it should read and the same objects get updated',
		},
	],
	decision: [
		{
			id: 'approve',
			label: 'Approve',
			tone: 'primary',
			rationale: 'I agree with the direction — proceed',
			recommended: true,
		},
		{
			id: 'send_back',
			label: 'Send back',
			tone: 'secondary',
			rationale: 'Needs changes before I sign off',
		},
	],
	sign_off: [
		{ id: 'sign_off', label: 'Sign off', tone: 'primary', recommended: true },
		{ id: 'send_back', label: 'Send back', tone: 'secondary' },
		{ id: 'snooze_24h', label: 'Snooze 24h', tone: 'secondary' },
	],
	proposed_bet: [
		{ id: 'open_bet', label: 'Open bet', tone: 'primary', recommended: true },
		{ id: 'refine', label: 'Refine first', tone: 'secondary' },
		{ id: 'dismiss', label: 'Dismiss', tone: 'secondary' },
	],
} as const

// Fallback chips used when a card doesn't map to a specific action-UI kind
// (decision / sign_off / proposed_bet). Keeps the pre-redesign feel on plain
// threads so we don't regress non-decision items.
export const QUICK_REPLY_CHIPS: readonly CardAction[] = [
	{ id: 'on_it', label: 'On it', tone: 'secondary' },
	{ id: 'approved', label: 'Approved', tone: 'secondary' },
	{ id: 'looks_good', label: 'Looks good', tone: 'secondary' },
	{ id: 'need_context', label: 'Need more context', tone: 'secondary' },
]

// Chips offered *after* a decision has been committed on a decision card. The
// mockup drops any quick reply that echoes an option the user just picked
// (`cuAfterQuick`, mockup 5962) — "Approved" reads as noise right under a
// receipt that already says "You chose Approve" — and falls back to a
// forward-looking pair when the filter empties the row.
export const AFTER_DECISION_FALLBACK_CHIPS: readonly CardAction[] = [
	{ id: 'rollback_plan', label: 'Show me the rollback plan', tone: 'secondary' },
	{ id: 'loop_me_in', label: 'Loop me on the results', tone: 'secondary' },
]

export function afterDecisionChips(
	options: readonly CardAction[] = CARD_ACTIONS.decision,
	chips: readonly CardAction[] = QUICK_REPLY_CHIPS,
): readonly CardAction[] {
	const heads = options
		.map((option) => option.label.split(' ')[0]?.toLowerCase() ?? '')
		.filter((head) => head.length > 0)
	const kept = chips.filter((chip) => {
		const label = chip.label.toLowerCase()
		return !heads.some((head) => label.includes(head))
	})
	return kept.length > 0 ? kept : AFTER_DECISION_FALLBACK_CHIPS
}
