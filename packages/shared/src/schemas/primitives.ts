import { z } from 'zod'
import { loopTargetSchema } from './loop-targets'

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

export type SafeJsonValue = z.infer<typeof safeJsonValue>
export type SafeMetadata = Record<string, SafeJsonValue>

// `metadata.targets` on a loop is a list of row objects (loopTargetSchema), the
// one place metadata may hold objects inside an array. The rows are checked one
// by one so a bad row is named in the error; every other key stays flat as above.
const METADATA_TARGETS_KEY = 'targets'
const metadataWithTargets = z
	.record(z.string(), z.union([safeJsonValue, z.array(z.record(z.string(), z.unknown()))]))
	.superRefine((metadata, ctx) => {
		for (const [key, value] of Object.entries(metadata)) {
			if (key !== METADATA_TARGETS_KEY) {
				if (
					Array.isArray(value) &&
					value.some((item) => typeof item === 'object' && item !== null)
				) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: [key],
						message: `${key} must be flat: only metadata.targets may hold a list of objects`,
					})
				}
				continue
			}
			// null or an empty list clears the targets, as before.
			if (value === null || (Array.isArray(value) && value.length === 0)) continue
			if (!Array.isArray(value)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: [key],
					message: 'targets must be a list of rows: { label, source, actual, target }',
				})
				continue
			}
			value.forEach((row, index) => {
				const parsed = loopTargetSchema.safeParse(row)
				if (parsed.success) return
				for (const issue of parsed.error.issues) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: [key, index, ...issue.path],
						message: `targets row ${index + 1}${issue.path.length ? ` (${issue.path.join('.')})` : ''}: ${issue.message}`,
					})
				}
			})
		}
	})

// Typed as the flat record it was before targets rows were allowed: the rows are
// validated above but callers keep the SafeMetadata shape they were written against.
export const safeMetadataSchema = metadataWithTargets as unknown as z.ZodType<SafeMetadata>

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
