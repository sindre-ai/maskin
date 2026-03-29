/** Safely parse JSON, returning null on failure or non-object results */
export function safeParseJson(text: string): unknown | null {
	try {
		const data = JSON.parse(text)
		return typeof data === 'object' && data !== null ? data : null
	} catch {
		return null
	}
}

/** Unwrap { data: T } envelope if present */
export function unwrapEnvelope(data: unknown): unknown {
	if (data && typeof data === 'object' && 'data' in data) {
		return (data as Record<string, unknown>).data
	}
	return data
}

/** Check if value is an array */
export function isArray(value: unknown): value is unknown[] {
	return Array.isArray(value)
}

/** Check if value is a non-array object, optionally with required keys */
export function isObject<T = unknown>(value: unknown, ...requiredKeys: string[]): value is T {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	if (requiredKeys.length === 0) return true
	return requiredKeys.every((key) => key in value)
}
