import type { UnreadItem } from '@/lib/api'

// The three action-UI weights the For You redesign renders per card.
// - `decision`  → shaded footer with full-width primary/secondary buttons (heavier stakes)
// - `sign_off`  → flat chip-row in the body (lighter — approve/send back)
// - `proposed_bet` → flat chip-row in the body (lighter — open/refine/dismiss)
// - `thread`    → fallback for anything that isn't decision-shaped (regular reply chips)
export type CardKind = 'decision' | 'sign_off' | 'proposed_bet' | 'thread'

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
}

// Kind → ordered list of affordances. First is always the primary action.
// Labels match the Designer's prototype (foryou-directions-A-B.html).
export const CARD_ACTIONS: Record<Exclude<CardKind, 'thread'>, readonly CardAction[]> = {
	decision: [
		{ id: 'approve', label: 'Approve', tone: 'primary' },
		{ id: 'send_back', label: 'Send back', tone: 'secondary' },
	],
	sign_off: [
		{ id: 'sign_off', label: 'Sign off', tone: 'primary' },
		{ id: 'send_back', label: 'Send back', tone: 'secondary' },
		{ id: 'snooze_24h', label: 'Snooze 24h', tone: 'secondary' },
	],
	proposed_bet: [
		{ id: 'open_bet', label: 'Open bet', tone: 'primary' },
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
