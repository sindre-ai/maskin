import { z } from 'zod'

// Event name shape: short identifier-ish strings (`menu_opened`,
// `delete_confirmation_shown`, etc.). Anything outside this character set is
// almost certainly call-site noise we don't want to persist.
const eventNameSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_.-]+$/, 'event name must be identifier-like')

// Props are a flat bag of JSON-y values (no nested objects/arrays — those
// belong in a stricter event schema later). The 4KB cap keeps a single misuse
// from filling the table with megabyte payloads.
const propsSchema = z
	.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
	.refine((p) => JSON.stringify(p).length <= 4096, {
		message: 'props payload exceeds 4KB',
	})

export const recordAnalyticsEventSchema = z.object({
	name: eventNameSchema,
	props: propsSchema.optional(),
	ts: z.string().datetime({ offset: true }).optional(),
})

export type RecordAnalyticsEventBody = z.infer<typeof recordAnalyticsEventSchema>
