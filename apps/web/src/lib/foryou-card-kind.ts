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

// Bets in these statuses signal a decision-point that expects approve / send-back.
const DECISION_BET_STATUSES = new Set(['in_review'])

// Tasks in these statuses signal an agent asking for sign-off.
const SIGN_OFF_TASK_STATUSES = new Set(['in_review'])

export function classifyCardKind(item: UnreadItem): CardKind {
	const type = item.object?.type
	const status = item.object?.status
	if (!type || !status) return 'thread'
	if (type === 'bet' && DECISION_BET_STATUSES.has(status)) return 'decision'
	if (type === 'task' && SIGN_OFF_TASK_STATUSES.has(status)) return 'sign_off'
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
