// In-memory dedup for the `slack_mention_received` ship-metric emit.
//
// Slack publishes both an `app_mention` and a `message` (with channel prefix
// `D`) event when a human DMs `@Maskin` — two distinct webhook deliveries
// with two distinct `event_id`s, but the same logical mention. The
// per-delivery `emittedOnce` guard in `tagSlackMentionEventsAndEmit` cannot
// see across deliveries, so without this helper a DM would double-count
// while a public-channel mention single-counts, biasing the bet's
// downstream-conversion ratio.
//
// We dedup by the inner Slack message identifier — `event.client_msg_id`
// when present, falling back to `event.ts` (the Slack message timestamp).
// Both fields are identical across the paired envelopes for the same
// message. Window is ~1 minute: Slack's docs say paired deliveries land
// within seconds, 1m gives plenty of slack without holding state past the
// point a real second mention with the same id could legitimately arrive.
//
// Backed by the same in-memory Map shape as `slack-attribution.ts` —
// process-local, intentionally not durable. Losing the window on a deploy
// or restart at worst lets one paired-DM emit double-count once; it never
// produces a wrong outcome on a non-paired mention.

const DEDUP_WINDOW_MS = 60 * 1000

const seenExpiresAt = new Map<string, number>()

function dedupKey(workspaceId: string, slackTeamId: string, messageId: string): string {
	return `${workspaceId}:${slackTeamId}:${messageId}`
}

function sweep(now: number): void {
	for (const [key, expiresAt] of seenExpiresAt) {
		if (expiresAt <= now) seenExpiresAt.delete(key)
	}
}

/**
 * Decide whether the `slack_mention_received` metric should be emitted for
 * this delivery. Returns `true` on a fresh mention (caller emits) and
 * `false` when an earlier paired envelope already emitted within the
 * dedup window.
 *
 * `messageId` should be the inner Slack `event.client_msg_id` if present,
 * else `event.ts`. When neither is available (`null` / empty), the helper
 * returns `true` — we'd rather over-count on a malformed payload than
 * silently drop a real mention.
 */
export function shouldEmitSlackMentionMetric(
	workspaceId: string,
	slackTeamId: string,
	messageId: string | null | undefined,
	now: number = Date.now(),
): boolean {
	if (!messageId) return true

	sweep(now)
	const key = dedupKey(workspaceId, slackTeamId, messageId)
	const expiresAt = seenExpiresAt.get(key)
	if (expiresAt !== undefined && expiresAt > now) return false

	seenExpiresAt.set(key, now + DEDUP_WINDOW_MS)
	return true
}

// Test-only. Production never needs to clear — entries self-evict via
// `sweep` on the next read after their TTL.
export function __resetSlackMentionDedupForTests(): void {
	seenExpiresAt.clear()
}
