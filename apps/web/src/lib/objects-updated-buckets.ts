// The Display panel's "Updated" filter axis (mockup script 6038's `UPDL`).
//
// Client-side, like the Attention axis: the list API sorts by `updatedAt` but
// has no recency-bucket filter, and adding one would mean a server that has to
// agree with the browser about what "today" is. Bucketing here keeps the
// viewer's own clock and timezone as the single reference.

export const UPDATED_BUCKETS = ['today', 'yesterday', 'week', 'older'] as const

export type UpdatedBucket = (typeof UPDATED_BUCKETS)[number]

export const UPDATED_BUCKET_LABELS: Record<UpdatedBucket, string> = {
	today: 'Today',
	yesterday: 'Yesterday',
	week: 'This week',
	older: 'Older',
}

export function isUpdatedBucket(value: unknown): value is UpdatedBucket {
	return typeof value === 'string' && (UPDATED_BUCKETS as readonly string[]).includes(value)
}

/** Calendar-day buckets in the viewer's local timezone — "yesterday" means the
 *  previous calendar date, not "24 to 48 hours ago", which is what a reader
 *  glancing at a date column expects it to mean. Returns null for a row with no
 *  `updatedAt` so it falls out of every bucket rather than landing in "older". */
export function updatedBucketOf(
	updatedAt: string | null | undefined,
	now: Date = new Date(),
): UpdatedBucket | null {
	if (!updatedAt) return null
	const updated = new Date(updatedAt)
	if (Number.isNaN(updated.getTime())) return null

	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
	const DAY_MS = 86_400_000
	const at = updated.getTime()

	if (at >= startOfToday) return 'today'
	if (at >= startOfToday - DAY_MS) return 'yesterday'
	// "This week" is the trailing 7 days rather than the current ISO week: on a
	// Monday morning a week-to-date bucket would be empty apart from today, and
	// a filter that is empty most Mondays is not a filter anyone reaches for.
	if (at >= startOfToday - 6 * DAY_MS) return 'week'
	return 'older'
}

/** The "New last 7 days" quick filter — the mockup's `upH0(o.updated) <= 168`. */
export function isUpdatedWithinWeek(
	object: { updatedAt?: string | null },
	now: Date = new Date(),
): boolean {
	if (!object.updatedAt) return false
	const at = new Date(object.updatedAt).getTime()
	if (Number.isNaN(at)) return false
	return now.getTime() - at <= 7 * 86_400_000
}
