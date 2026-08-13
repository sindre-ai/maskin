import type { NotificationResponse } from '@/lib/api'

// The four For You buckets, ordered by the parent bet AC (Decision needed first,
// Handled today last). The bucket key doubles as the header render key and the
// analytics slice T7 will pick up later.
export type ForYouBucket = 'decision' | 'waiting' | 'fyi' | 'handled'

export interface ForYouBucketMeta {
	key: ForYouBucket
	label: string
}

export const FORYOU_BUCKET_ORDER: readonly ForYouBucketMeta[] = [
	{ key: 'decision', label: 'Decision needed' },
	{ key: 'waiting', label: 'Waiting on agents' },
	{ key: 'fyi', label: 'FYI' },
	{ key: 'handled', label: 'Handled today' },
]

const HANDLED_WINDOW_MS = 24 * 60 * 60 * 1000

// A single collapsed row inside a bucket. `count === 1` renders as a plain
// notification card; count > 1 renders as a grouped card with a bulk action.
export interface ForYouGroup {
	// Stable key for React lists: objectId when we have one, else the primary
	// notification id (single-item groups without an objectId are their own
	// key so they never collide with a real group).
	key: string
	bucket: ForYouBucket
	objectId: string | null
	// The most recent notification in the group — drives title/preview/quick
	// actions when there's only one item, and is the "representative" the
	// header shows when the group is collapsed.
	primary: NotificationResponse
	// Everything in the group in newest-first order (primary is index 0).
	items: NotificationResponse[]
}

interface ClassifyOptions {
	// Defaults to `Date.now()` — tests inject a fixed clock so "handled today"
	// stays deterministic.
	now?: number
}

// Classify a notification into one of the four buckets. Ordering of the
// checks matters: `resolved` items either land in Waiting (dispatch still
// pending) or Handled (dispatch already done or resolvedAt beyond the
// handled-today window).
export function classifyNotification(
	notification: NotificationResponse,
	options: ClassifyOptions = {},
): ForYouBucket {
	const now = options.now ?? Date.now()

	if (notification.status === 'resolved') {
		if (notification.dispatchAt && !notification.wakeDispatched) return 'waiting'
		const resolvedAt = notification.resolvedAt ? Date.parse(notification.resolvedAt) : null
		if (
			resolvedAt !== null &&
			Number.isFinite(resolvedAt) &&
			now - resolvedAt <= HANDLED_WINDOW_MS
		) {
			return 'handled'
		}
		return 'handled'
	}

	// Anything still pending/seen with structured options or an explicit
	// needs_input type is a decision the human owes.
	const metadata = (notification.metadata ?? {}) as Record<string, unknown>
	const hasOptions = Array.isArray(metadata.options) && (metadata.options as unknown[]).length > 0
	if (hasOptions || notification.type === 'needs_input') return 'decision'

	// Everything else attention-needed (recommendations, good_news, alerts)
	// falls into FYI so the human sees it in the feed without a decision cost.
	return 'fyi'
}

// Group notifications into per-bucket collections, collapsing same-`objectId`
// items into one group. Notifications without an objectId never collapse —
// they're their own single-item group so grouped bulk-actions can't fire on
// a heterogeneous batch.
export function groupNotifications(
	notifications: readonly NotificationResponse[],
	options: ClassifyOptions = {},
): Record<ForYouBucket, ForYouGroup[]> {
	const now = options.now ?? Date.now()
	const buckets: Record<ForYouBucket, Map<string, ForYouGroup>> = {
		decision: new Map(),
		waiting: new Map(),
		fyi: new Map(),
		handled: new Map(),
	}
	// Standalone (no objectId) entries — appended after grouped ones so
	// collapsed groups sort first inside each bucket.
	const standalone: Record<ForYouBucket, ForYouGroup[]> = {
		decision: [],
		waiting: [],
		fyi: [],
		handled: [],
	}

	// Sort newest-first once so `primary` on each group is the newest entry
	// and same-objectId items land newest-first inside `items`.
	const sorted = [...notifications].sort((a, b) => timestampOf(b) - timestampOf(a))

	for (const notification of sorted) {
		const bucket = classifyNotification(notification, { now })
		if (notification.objectId) {
			const bucketMap = buckets[bucket]
			const existing = bucketMap.get(notification.objectId)
			if (existing) {
				existing.items.push(notification)
			} else {
				bucketMap.set(notification.objectId, {
					key: `${bucket}:${notification.objectId}`,
					bucket,
					objectId: notification.objectId,
					primary: notification,
					items: [notification],
				})
			}
		} else {
			standalone[bucket].push({
				key: `${bucket}:notification:${notification.id}`,
				bucket,
				objectId: null,
				primary: notification,
				items: [notification],
			})
		}
	}

	return {
		decision: [...buckets.decision.values(), ...standalone.decision],
		waiting: [...buckets.waiting.values(), ...standalone.waiting],
		fyi: [...buckets.fyi.values(), ...standalone.fyi],
		handled: [...buckets.handled.values(), ...standalone.handled],
	}
}

// Pull the bulk-response body for a group. Uses each notification's
// `metadata.recommendation` when set (that's the schema-wall recommendation the
// agent already vetted), else falls back to `defaultAction`. All members of a
// group share an object, so a single response value applies to the whole batch.
export function bulkResponseFor(group: ForYouGroup): { response: unknown } | null {
	const recommendation = readRecommendation(group.primary)
	if (recommendation !== null) return { response: recommendation }
	if (group.primary.defaultAction) return { response: group.primary.defaultAction }
	return null
}

function readRecommendation(notification: NotificationResponse): string | null {
	const metadata = notification.metadata as Record<string, unknown> | null
	if (!metadata) return null
	const value = metadata.recommendation
	return typeof value === 'string' && value.trim() !== '' ? value : null
}

function timestampOf(notification: NotificationResponse): number {
	const raw = notification.updatedAt ?? notification.createdAt
	if (!raw) return 0
	const parsed = Date.parse(raw)
	return Number.isFinite(parsed) ? parsed : 0
}
