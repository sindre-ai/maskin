import type { EventResponse } from '@/lib/api'

/**
 * Whether a comment asked its reader to make a call.
 *
 * The agent says so by attaching a `decision` block (`commentDecisionSchema`),
 * and that is the only way to say it. `metadata.chips` used to be a second,
 * weaker way — a bare list of labels with no title, no consequences and no
 * recommendation — and having both meant agents reached for the weaker one.
 * Comments written before it was removed still carry chips; they read as the
 * plain comments they are.
 */
export function hasDecision(event: EventResponse): boolean {
	if (event.action !== 'commented') return false
	const decision = event.data?.decision
	return !!decision && typeof decision === 'object'
}
