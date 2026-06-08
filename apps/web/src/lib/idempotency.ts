// `crypto.randomUUID` is the right primitive, but on legacy iOS Safari and in
// non-secure-context webviews/iframes the property is *present* yet throws
// `NotSupportedError` when called. A `'randomUUID' in crypto` presence check
// passes there, the throw bubbles into a generic catch, and the user's submit
// silently fails. Calling it inside try/catch is the only check that holds.
// The fallback also covers non-secure-context jsdom in unit tests.
//
// The API treats `Idempotency-Key` as an opaque string, so the format doesn't
// matter as long as the same key is sent for a double-tap of the same submit.
export function newIdempotencyKey(): string {
	if (typeof crypto !== 'undefined') {
		try {
			return crypto.randomUUID()
		} catch {
			// fall through to the Date/Math.random fallback
		}
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
