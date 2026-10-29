// Keyed token bucket — the per-key request budget at the MCP surface.
//
// First consumer is google_drive__get_sheet_range: the Sheets API caps reads
// at 300 per minute per user per project, so the Sheets tool spends from a
// bucket keyed by workspace id (250 per minute) and answers RATE_LIMIT_EXCEEDED
// from our side instead of letting a Google 429 reach the agent.
//
// Each key gets its own bucket of `capacity` tokens that refills continuously
// at `refillPerWindow / windowMs` (`refillPerWindow` defaults to `capacity`).
// A full bucket allows a burst of `capacity` calls; after that, calls are
// admitted at the refill rate. Any window of `windowMs` therefore admits at
// most `capacity + refillPerWindow` calls, so a caller with a hard upstream cap
// sets the two to sum to it. A denied take reports `retryAfterMs` so the caller
// can hand the agent a concrete backoff.
//
// State lives in this process's memory, so the budget is per API process, not
// shared across replicas. A cross-process limit is out of scope here.

export interface KeyedTokenBucketOptions {
	/** Tokens a full bucket holds: the burst size. */
	capacity: number
	/** Window over which `refillPerWindow` tokens are added. */
	windowMs: number
	/** Tokens added per `windowMs`. Defaults to `capacity`. */
	refillPerWindow?: number
	/** Clock override for tests. Defaults to Date.now. */
	now?: () => number
}

export type TakeResult =
	| { allowed: true; remaining: number }
	| { allowed: false; retryAfterMs: number }

export interface KeyedTokenBucket {
	/** Spend `cost` tokens (default 1) from the bucket for `key`. */
	take(key: string, cost?: number): TakeResult
}

interface BucketState {
	tokens: number
	updatedAt: number
}

export function createKeyedTokenBucket(options: KeyedTokenBucketOptions): KeyedTokenBucket {
	const { capacity, windowMs, refillPerWindow = capacity, now = Date.now } = options
	if (!(capacity > 0) || !(windowMs > 0) || !(refillPerWindow > 0)) {
		throw new Error(
			'createKeyedTokenBucket: capacity, windowMs and refillPerWindow must be positive',
		)
	}

	const refillPerMs = refillPerWindow / windowMs
	const buckets = new Map<string, BucketState>()

	return {
		take(key, cost = 1) {
			if (!(cost > 0) || cost > capacity) {
				throw new Error(`take: cost must be positive and at most capacity (${capacity})`)
			}

			const t = now()
			const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: t }
			bucket.tokens = Math.min(capacity, bucket.tokens + (t - bucket.updatedAt) * refillPerMs)
			bucket.updatedAt = t
			buckets.set(key, bucket)

			if (bucket.tokens < cost) {
				return { allowed: false, retryAfterMs: Math.ceil((cost - bucket.tokens) / refillPerMs) }
			}
			bucket.tokens -= cost
			return { allowed: true, remaining: Math.floor(bucket.tokens) }
		},
	}
}
