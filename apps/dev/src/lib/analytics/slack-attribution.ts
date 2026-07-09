// In-memory attribution window for Slack-originated workspace activity.
//
// The bet's success metric requires ≥40% of @Maskin mentions to produce a
// downstream Maskin object change. To compute that we need a way to tell, at
// the moment an object change is written, whether it was caused by a Slack
// mention or DM that landed within the last 4h.
//
// Storing the window in memory is intentional. The attribution is advisory
// telemetry, not a security or billing decision: losing a window on a deploy
// or restart means a downstream change goes untagged, which only smudges the
// metric — it does not produce a wrong outcome. A DB-backed table would add
// schema, writes per webhook, and a sweep job for a signal that is already
// directional. If a future bet needs cross-instance attribution, swap the
// backing store; the public API can stay.
//
// Public API:
// - markSlackMention(workspaceId)        — call once per dedup'd inbound mention.
// - consumeSlackAttribution(workspaceId) — call at downstream write time to
//   decide whether to attach `source: 'slack_mention'` to the event row. The
//   window expires 4h after the most recent mark; consume is read-only.

const ATTRIBUTION_WINDOW_MS = 4 * 60 * 60 * 1000

const windowExpiresAt = new Map<string, number>()

export function markSlackMention(workspaceId: string, now: number = Date.now()): void {
	windowExpiresAt.set(workspaceId, now + ATTRIBUTION_WINDOW_MS)
}

export function consumeSlackAttribution(workspaceId: string, now: number = Date.now()): boolean {
	const expiresAt = windowExpiresAt.get(workspaceId)
	if (expiresAt === undefined) return false
	if (expiresAt <= now) {
		// Drop the stale entry so the map doesn't grow unbounded over a long
		// uptime. The "downstream change has source" question is binary, so
		// reading a stale entry once and dropping it is enough.
		windowExpiresAt.delete(workspaceId)
		return false
	}
	return true
}

// Test-only. Production code should never need to clear the window —
// markSlackMention is idempotent and consumeSlackAttribution self-evicts on
// staleness.
export function __resetSlackAttributionForTests(): void {
	windowExpiresAt.clear()
}
