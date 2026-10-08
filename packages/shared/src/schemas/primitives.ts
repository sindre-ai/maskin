import { z } from 'zod'

const jsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()])
export const safeJsonValue = z.union([jsonPrimitive, z.array(jsonPrimitive)])
export const safeMetadataSchema = z.record(z.string(), safeJsonValue)

export type SafeJsonValue = z.infer<typeof safeJsonValue>
export type SafeMetadata = z.infer<typeof safeMetadataSchema>

/**
 * A boolean read from a query string.
 *
 * Not `z.coerce.boolean()`: that runs `Boolean(str)`, so every non-empty string, including the
 * literal "false", becomes `true`. A client that sent `?archived=false` got the archived list.
 * Accepts true/false/1/0 (case-insensitive) and an empty value as false; anything else is a 400
 * rather than a silent guess. Reads through to `z.boolean()` for OpenAPI.
 */
export const booleanQueryParam = z.preprocess((value) => {
	if (typeof value !== 'string') return value
	const normalized = value.trim().toLowerCase()
	if (normalized === 'true' || normalized === '1') return true
	if (normalized === 'false' || normalized === '0' || normalized === '') return false
	return value
}, z.boolean())
