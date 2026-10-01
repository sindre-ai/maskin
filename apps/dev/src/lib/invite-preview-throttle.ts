// Per-IP token-bucket throttle for the unauthenticated `GET /api/invites/preview`
// endpoint. Adapted from the primitive in `apps/dev/src/lib/guest-throttle.ts`
// (which is DB-scoped to landing-page bet drafts and doesn't fit an
// enumeration-flood guard) — the shape matches the token-bucket used in
// `apps/dev/src/routes/public-landing-events.ts`, which is the closest
// production precedent for a per-IP flood guard on a no-auth endpoint.
//
// The endpoint returns invite metadata for a hashed-at-rest token. An attacker
// with unlimited requests could probe the 256-bit token space or fingerprint
// churn — the bucket is a flood guard, not a billing meter, so cross-instance
// accuracy is unnecessary. The map is bounded so a hostile caller cannot grow
// it without limit.

const BUCKET_CAPACITY = 60
// 30 refills per minute — a real invitee only ever loads /invite once or twice
// per browser tab, so 30/min per IP is generously above legitimate use and
// still forces even a modestly parallel attacker to slow down or spread IPs.
const BUCKET_REFILL_PER_MS = 30 / (60 * 1000)

type Bucket = { tokens: number; lastSeen: number }
const buckets = new Map<string, Bucket>()

const BUCKET_MAP_CAP = 10_000

export function takeInvitePreviewToken(ip: string, now: number = Date.now()): boolean {
	const existing = buckets.get(ip)
	let tokens = BUCKET_CAPACITY
	if (existing) {
		const elapsed = now - existing.lastSeen
		tokens = Math.min(BUCKET_CAPACITY, existing.tokens + elapsed * BUCKET_REFILL_PER_MS)
	}
	if (tokens < 1) {
		buckets.set(ip, { tokens, lastSeen: now })
		return false
	}
	buckets.set(ip, { tokens: tokens - 1, lastSeen: now })
	if (buckets.size > BUCKET_MAP_CAP) {
		// Iteration order is insertion order in JS, so the head is the oldest entry.
		const drop = Math.floor(BUCKET_MAP_CAP * 0.1)
		let i = 0
		for (const key of buckets.keys()) {
			if (i++ >= drop) break
			buckets.delete(key)
		}
	}
	return true
}

// Test-only reset so integration tests can isolate cases per describe/it.
export function _resetInvitePreviewBuckets(): void {
	buckets.clear()
}
