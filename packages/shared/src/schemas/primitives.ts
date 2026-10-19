import { z } from 'zod'

// A function, not a shared constant: zod-to-json-schema emits a `$ref` when one
// schema instance appears twice in a tool's input schema, and some providers
// (DigitalOcean on OpenRouter) reject a `$ref` in a tool schema with a 400. A
// fresh instance per use keeps the generated schema inline.
const jsonPrimitive = () => z.union([z.string(), z.number(), z.boolean(), z.null()])
// Shallowly-nested map of string → string-array — narrowly permitted so
// loop.metadata.closed_statuses ({ [type]: [status, ...] }) can round-trip
// through the write path. The reader in apps/dev/src/routes/loops.ts has
// always expected this shape; the write path rejected it until this entry
// was added. Deeper nesting is still rejected; other value shapes stay flat.
const stringArrayMap = z.record(z.string(), z.array(z.string()))
export const safeJsonValue = z.union([jsonPrimitive(), z.array(jsonPrimitive()), stringArrayMap])
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
