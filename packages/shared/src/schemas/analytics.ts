import { z } from 'zod'

// First-party UI analytics events emitted by apps/web's trackEvent helper to
// POST /api/analytics. Workspace id comes from the X-Workspace-Id header
// (auth middleware enforces membership); actor id from the bearer token.
//
// `name` is identifier-ish (1–128 chars) so KPI queries can group on it
// without surprises (no leading whitespace, no newlines). `props` is free-form
// jsonb but capped at ~4KB after JSON-stringify to keep a single misbehaving
// caller from filling the table or blowing PG NOTIFY budgets on consumers.
// `ts` is informational only — the row's createdAt is server-side.

const MAX_PROPS_SERIALIZED_BYTES = 4096

// Schema is imported in both Node and the browser, so count bytes with
// TextEncoder rather than Buffer (which only exists in Node).
function utf8ByteLength(s: string): number {
	return new TextEncoder().encode(s).byteLength
}

const propsValueSchema: z.ZodType<unknown> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(propsValueSchema),
		z.record(propsValueSchema),
	]),
)

export const trackEventSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(128)
		.regex(/^[A-Za-z0-9_.-]+$/, 'event name must be identifier-like'),
	props: z
		.record(propsValueSchema)
		.optional()
		.refine(
			(p) => p === undefined || utf8ByteLength(JSON.stringify(p)) <= MAX_PROPS_SERIALIZED_BYTES,
			{ message: `props must serialize to <= ${MAX_PROPS_SERIALIZED_BYTES} bytes` },
		),
	ts: z.string().datetime({ offset: true }).optional(),
})

export type TrackEventBody = z.infer<typeof trackEventSchema>
