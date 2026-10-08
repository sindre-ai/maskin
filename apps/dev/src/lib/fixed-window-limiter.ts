/**
 * A small in-process fixed-window rate limiter, keyed by an arbitrary string (an IP, an actor id).
 *
 * In-process on purpose, like the other flood guards in this app: it is a brake on guessing and
 * hammering, not a billing meter, and the deployment is a single instance. The map is capped so a
 * hostile caller cannot grow it without bound.
 */
export interface WindowLimiter {
	/** Records one hit for `key`. `allowed: false` means the caller should answer 429. */
	hit(key: string, now?: number): { allowed: boolean; retryAfterMs: number }
	/** Test-only. */
	reset(): void
}

export function createWindowLimiter(options: {
	limit: number
	windowMs: number
	maxKeys?: number
}): WindowLimiter {
	const { limit, windowMs, maxKeys = 10_000 } = options
	const windows = new Map<string, { startedAt: number; count: number }>()

	return {
		hit(key, now = Date.now()) {
			const current = windows.get(key)
			if (!current || now - current.startedAt >= windowMs) {
				if (windows.size >= maxKeys) {
					// Drop the oldest tenth; Map iteration order is insertion order.
					let toDrop = Math.ceil(maxKeys / 10)
					for (const k of windows.keys()) {
						windows.delete(k)
						if (--toDrop <= 0) break
					}
				}
				windows.delete(key)
				windows.set(key, { startedAt: now, count: 1 })
				return { allowed: true, retryAfterMs: 0 }
			}
			current.count += 1
			if (current.count > limit) {
				return { allowed: false, retryAfterMs: Math.max(1, current.startedAt + windowMs - now) }
			}
			return { allowed: true, retryAfterMs: 0 }
		},
		reset() {
			windows.clear()
		},
	}
}
