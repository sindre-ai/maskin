import type { UnreadItem } from '@/lib/api'
import { isInformational } from '@/lib/foryou-card-kind'

/**
 * Pure helpers behind the For You feed (mockup `Maskin For You - Feed v4`).
 *
 * The feed renders a scrolling column of cards, each in one of three states —
 * `row` (collapsed), `full` (expanded) or `done` (a decision receipt) — and
 * orders them by which bucket they fall in. Everything that can be decided
 * without React lives here so it can be tested directly.
 */

// The card's trailing timestamp is a mono micro-label — "5H", "1D", "AUG 12"
// (mockup's `c.time`). Minutes are the smallest unit the feed shows.
export function compactTime(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return ''
	const then = new Date(iso).getTime()
	if (!Number.isFinite(then)) return ''
	const minutes = Math.floor((now - then) / 60_000)
	if (minutes < 1) return 'NOW'
	if (minutes < 60) return `${minutes}M`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}H`
	const days = Math.floor(hours / 24)
	if (days < 7) return `${days}D`
	return new Date(then)
		.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
		.toUpperCase()
}

// The amber "held 3 days" note beside the status word: how long a card that
// still needs a person has been sitting in the feed (mockup's `c.waitNote`).
// Nothing is said until a card has been waiting two full days.
/** A long sender name shrinks to its first name so the byline stays on one line. */
export function bylineName(name: string | null | undefined): string {
	if (!name) return ''
	return name.length > 18 ? (name.split(' ')[0] ?? name) : name
}

export function heldNote(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return ''
	const then = new Date(iso).getTime()
	if (!Number.isFinite(then)) return ''
	const days = Math.floor((now - then) / 86_400_000)
	if (days < 2) return ''
	if (days >= 7) return 'held over a week'
	return `held ${days} ${days === 1 ? 'day' : 'days'}`
}

/**
 * The four buckets the feed orders by (mockup's `bucket()`), rendered without
 * headings — the ordering is the grouping.
 *
 * - `needs`   — a person has to answer or decide
 * - `waiting` — the ball is with an agent (you answered last)
 * - `fyi`     — nothing to decide, just new activity
 * - `done`    — decided in this sitting; the green receipt strip
 */
export type FeedBucket = 'needs' | 'waiting' | 'fyi' | 'done'

export const BUCKET_ORDER: readonly FeedBucket[] = ['needs', 'waiting', 'fyi', 'done']

export function bucketRank(bucket: FeedBucket): number {
	const index = BUCKET_ORDER.indexOf(bucket)
	return index === -1 ? BUCKET_ORDER.length : index
}

/**
 * `entity_type` of a For You card that is not about an object (the morning budget card). Its
 * `entity_id` is the notification's own id, and reading it dismisses that notification.
 */
export const NOTIFICATION_ENTITY = 'notification'

/** A card with no object behind it: nothing to open, no thread to reply in. */
export function isObjectlessCard(item: Pick<UnreadItem, 'entity_type'>): boolean {
	return item.entity_type === NOTIFICATION_ENTITY
}

export function feedItemKey(item: UnreadItem): string {
	return `${item.entity_type}:${item.entity_id}`
}

/**
 * The line that closes an empty column (mockup's `tail`). It only ever renders
 * when there is nothing to read — a feed with cards in it needs no epitaph.
 */
export function feedTailLabel({
	filtered,
	kindLabel,
}: { filtered: boolean; kindLabel?: string }): string {
	if (!filtered) return "You're caught up"
	return kindLabel ? `Nothing in ${kindLabel}` : 'Nothing here'
}

/**
 * What kind of card this is, for the Display menu's filters and the pill row:
 * a message waiting to be sent is a Draft, an agent's ask is a Decision, and a
 * note that asks nothing is an Update (the prototype's Decisions / Drafts / Updates).
 */
export type FeedKind = 'decision' | 'draft' | 'update'

export const FEED_KIND_LABEL: Record<FeedKind, string> = {
	decision: 'Decisions',
	draft: 'Drafts',
	update: 'Updates',
}

/**
 * A filter value that is not a card kind (anything left over from the old item-type
 * filter) means no filter, so a stale value can never hide the whole feed.
 */
export function feedKindFilter(value: string | undefined): FeedKind | undefined {
	return value !== undefined && Object.hasOwn(FEED_KIND_LABEL, value)
		? (value as FeedKind)
		: undefined
}

/**
 * Decision and draft come from the decision block the agent attached (a draft when it
 * carries a message to send). Update is exactly the "Updates for you" section's rule,
 * `isInformational`: no decision, and the comment neither scores high on attention nor
 * contains a question. The feed has no server-side card kind, so the pill and the section
 * agree because they call the same function.
 */
export function feedKindOf(item: UnreadItem): FeedKind {
	const decision = item.latest_mention?.decision
	if (decision && (decision.draft || (decision.drafts?.length ?? 0) > 0)) return 'draft'
	return isInformational(item) ? 'update' : 'decision'
}

/**
 * What a bulk dismiss ("Dismiss all", Alt+U) may touch: never a card that is
 * waiting on a decision or an answer from the person.
 */
export function dismissableItems<T>(items: readonly T[], bucketOf: (item: T) => FeedBucket): T[] {
	return items.filter((item) => {
		const bucket = bucketOf(item)
		return bucket !== 'needs'
	})
}
