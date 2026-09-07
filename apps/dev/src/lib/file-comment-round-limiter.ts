import { ROUND_RATE_LIMIT_PER_MINUTE, ROUND_RATE_LIMIT_WINDOW_MS } from '@maskin/shared'

// Per-actor sliding-window record of when this actor's most recent successful
// rounds landed. Kept in-process because the round endpoint is a low-QPS
// admin action (humans clicking Send in a review viewer, not a webhook path);
// a shared limiter would be overkill and would burn a DB round-trip on the
// happy path. Under the current single-instance dev+prod deployment this is
// the right trade; if apps/dev ever runs behind a horizontal fan-out, migrate
// to a DB or Redis window keyed the same way.
const timestampsByActor = new Map<string, number[]>()

export interface RoundRateLimitCheck {
	allowed: boolean
	retryAfterMs: number
}

/**
 * Reserve a slot for the actor's next round-send. On `allowed: true` the
 * caller MUST proceed with the write; on `allowed: false` the caller MUST
 * return 429 without doing any work. Idempotent retries (same `roundId`
 * that already committed) must short-circuit BEFORE this call, so a wobbly
 * client's retry doesn't burn a rate-limit slot.
 */
export function reserveRoundSlot(
	actorId: string,
	now: number = Date.now(),
	cap: number = ROUND_RATE_LIMIT_PER_MINUTE,
	windowMs: number = ROUND_RATE_LIMIT_WINDOW_MS,
): RoundRateLimitCheck {
	const cutoff = now - windowMs
	const prior = timestampsByActor.get(actorId) ?? []
	// Drop anything outside the window; the map entry can grow at most to
	// `cap` entries in-window plus a handful of decayed ones from the last
	// second, so a per-call scan is fine here.
	const inWindow = prior.filter((ts) => ts > cutoff)
	if (inWindow.length >= cap) {
		// After the length check `inWindow[0]` is always defined; the non-null
		// assertion keeps TS strict-null happy without a runtime guard.
		const oldest = inWindow[0] as number
		const retryAfterMs = Math.max(1, oldest + windowMs - now)
		timestampsByActor.set(actorId, inWindow)
		return { allowed: false, retryAfterMs }
	}
	inWindow.push(now)
	timestampsByActor.set(actorId, inWindow)
	return { allowed: true, retryAfterMs: 0 }
}

/**
 * Test-only reset. Vitest reuses module state across cases in a file, so an
 * integration test that walks the actor up to 10 successful rounds would
 * poison every subsequent test that shares the actor id. Called from
 * `beforeEach` in the file-comments integration suite.
 */
export function resetRoundLimiterForTests() {
	timestampsByActor.clear()
}
