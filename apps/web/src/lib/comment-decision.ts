import type { EventResponse } from '@/lib/api'
import { type CommentDecision, parseCommentDecision } from '@maskin/shared'

/**
 * The decision a comment attached, or `null` if it asked for nothing.
 *
 * The agent says it needs a call by attaching a `decision` block, and that is
 * the only way to say it. `metadata.chips` used to be a second, weaker way — a
 * bare list of labels with no title, no consequences and no recommendation —
 * and having both meant agents reached for the weaker one. Comments written
 * before it was removed still carry chips; `legacyChipsOf` reads them so the
 * options stay legible, but they are not a decision.
 *
 * The block is parsed against `commentDecisionSchema` rather than duck-typed,
 * so this surface, the For You feed and the orphan-thread detector all agree
 * about what counts.
 */
export function decisionOfEvent(event: EventResponse): CommentDecision | null {
	if (event.action !== 'commented') return null
	return parseCommentDecision(event.data?.decision)
}

/** Whether a comment asked its reader to make a call. */
export function hasDecision(event: EventResponse): boolean {
	return decisionOfEvent(event) !== null
}

/**
 * The labels of a pre-`decision` comment's `metadata.chips`, if it carries any.
 *
 * These never lived in the comment's `content` — they were rendered from the
 * metadata alone — so a stored chip comment whose options went unrendered would
 * show the reader a question with its choices missing. Already-provisioned
 * agents also keep writing chips until they are reprovisioned, since editing a
 * template does not touch a stored system prompt. Reading them back is not a
 * revival of the mechanism: they render as text, not as buttons, and nothing
 * treats them as a decision.
 */
export function legacyChipsOf(event: EventResponse): string[] {
	if (event.action !== 'commented') return []
	const metadata = event.data?.metadata
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return []
	const chips = (metadata as Record<string, unknown>).chips
	if (!Array.isArray(chips)) return []
	return chips.filter((chip): chip is string => typeof chip === 'string' && chip.trim().length > 0)
}
