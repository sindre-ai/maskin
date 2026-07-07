// Idempotency keys for write requests and stable temp IDs for optimistic UI.
// The API treats `Idempotency-Key` as an opaque string, so the format only
// has to be unique-ish per logical operation. We try `crypto.randomUUID()`
// inside a try/catch because legacy iOS Safari, non-secure-context iframes,
// and some webviews expose the method but throw on call. A bare presence
// check (`'randomUUID' in crypto`) lets that throw bubble up into callers'
// catch blocks and surface as a generic "something went wrong" error.
export function newIdempotencyKey(): string {
	if (typeof crypto !== 'undefined') {
		try {
			return crypto.randomUUID()
		} catch {
			// fall through to the timestamp-based fallback
		}
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
