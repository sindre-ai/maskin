import type { UnreadItem } from '@/lib/api'

/**
 * Pure helpers behind the For You feed (mockup `Maskin For You - Feed v4`).
 *
 * The feed renders a scrolling column of cards, each in one of three states —
 * `row` (collapsed), `full` (expanded) or `done` (a decision receipt) — and
 * orders them by which bucket they fall in. Everything that can be decided
 * without React lives here so it can be tested directly.
 */

// The amber "held 3 days" note beside the status word: how long a card that
// still needs a person has been sitting in the feed (mockup's `c.waitNote`).
// Nothing is said until a card has been waiting a full day.
export function heldNote(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return ''
	const then = new Date(iso).getTime()
	if (!Number.isFinite(then)) return ''
	const days = Math.floor((now - then) / 86_400_000)
	if (days < 1) return ''
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

export function feedItemKey(item: UnreadItem): string {
	return `${item.entity_type}:${item.entity_id}`
}

/**
 * The line that closes an empty column (mockup's `tail`). It only ever renders
 * when there is nothing to read — a feed with cards in it needs no epitaph.
 */
export function feedTailLabel({ filtered }: { filtered: boolean }): string {
	return filtered ? 'Nothing of this kind in the feed' : 'Feed cleared'
}
