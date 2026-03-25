/**
 * Converts Drizzle records to JSON-safe objects by serializing Date fields to ISO strings.
 * This ensures handler return types match the Zod response schemas (which use z.string() for dates).
 */
export function serialize<T extends Record<string, unknown>>(
	record: T,
): {
	[K in keyof T]: T[K] extends Date | null ? string | null : T[K] extends Date ? string : T[K]
} {
	const result = {} as Record<string, unknown>
	for (const [key, value] of Object.entries(record)) {
		result[key] = value instanceof Date ? value.toISOString() : value
	}
	return result as {
		[K in keyof T]: T[K] extends Date | null ? string | null : T[K] extends Date ? string : T[K]
	}
}

export function serializeArray<T extends Record<string, unknown>>(
	records: T[],
): {
	[K in keyof T]: T[K] extends Date | null ? string | null : T[K] extends Date ? string : T[K]
}[] {
	return records.map(serialize)
}
