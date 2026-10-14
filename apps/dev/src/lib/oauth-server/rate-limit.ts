/**
 * A tiny fixed-window limiter for routes that take no API key. In memory and per process: it slows a
 * guesser down, it is not the thing that makes guessing hopeless (codes and tokens carry 256 bits).
 */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
	const hits = new Map<string, { count: number; resetAt: number }>()
	return function allow(key: string): boolean {
		const t = now()
		if (hits.size > 5000) {
			for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k)
		}
		const entry = hits.get(key)
		if (!entry || entry.resetAt <= t) {
			hits.set(key, { count: 1, resetAt: t + windowMs })
			return true
		}
		entry.count += 1
		return entry.count <= limit
	}
}
