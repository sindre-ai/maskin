import { z } from 'zod'

// Cap emoji length so an attacker can't fill the table with arbitrary text
// disguised as an "emoji". 32 bytes comfortably fits any user-visible glyph
// including ZWJ-joined sequences (👨‍👩‍👧 etc.) while keeping the unique
// constraint and the SSE payload size small.
export const REACTION_EMOJI_MAX_LENGTH = 32

export const reactionEmojiSchema = z
	.string()
	.min(1, 'Emoji cannot be empty')
	.max(REACTION_EMOJI_MAX_LENGTH, `Emoji must be ${REACTION_EMOJI_MAX_LENGTH} characters or fewer`)

export const toggleReactionBodySchema = z.object({
	event_id: z.number().int().positive(),
	emoji: reactionEmojiSchema,
})

// Cap how many reaction rows the bulk fetch returns in one round-trip. Without
// it, a long-lived object thread with hundreds of comments and tens of
// reactions each can produce a payload that exceeds 1MB. 500 is comfortably
// above what fits on a screen of activity; 1000 is the hard ceiling clients
// can opt into for the rare wide-window case.
export const REACTIONS_DEFAULT_LIMIT = 500
export const REACTIONS_MAX_LIMIT = 1000

// Server-side cap on the number of distinct event ids a client can ask about
// in one round-trip. The bulk fetch builds an `IN (...)` clause, which grows
// O(n); 200 visible messages comfortably covers a windowed chat transcript
// and stops a curious client from blowing the URL/query-plan budget.
export const REACTIONS_MAX_EVENT_IDS = 200

// `event_ids` arrives as a comma-separated string on the query string
// (e.g. `?event_ids=10,11,12`). We parse + validate here so the route never
// sees `NaN` or duplicates: integers only, deduplicated, capped.
const eventIdsParam = z.string().transform((s, ctx) => {
	const parts = s.split(',')
	const out: number[] = []
	const seen = new Set<number>()
	for (const part of parts) {
		const trimmed = part.trim()
		if (trimmed === '') continue
		const n = Number(trimmed)
		if (!Number.isInteger(n) || n <= 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `event_ids must be positive integers (got ${JSON.stringify(trimmed)})`,
			})
			return z.NEVER
		}
		if (seen.has(n)) continue
		seen.add(n)
		out.push(n)
	}
	if (out.length > REACTIONS_MAX_EVENT_IDS) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `event_ids supports at most ${REACTIONS_MAX_EVENT_IDS} ids per request`,
		})
		return z.NEVER
	}
	return out
})

export const reactionsByObjectQuerySchema = z
	.object({
		object_id: z.string().uuid().optional(),
		event_ids: eventIdsParam.optional(),
		// `z.coerce` so the string query param parses cleanly; bounds + integer
		// check defend against NaN propagation (see known-pitfalls.md).
		limit: z.coerce
			.number()
			.int()
			.positive()
			.max(REACTIONS_MAX_LIMIT)
			.optional()
			.default(REACTIONS_DEFAULT_LIMIT),
	})
	.refine((q) => (q.object_id ? !q.event_ids : !!q.event_ids), {
		message: 'Provide exactly one of object_id or event_ids',
	})

// Reaction shape returned by the API. The bulk-by-object response groups by
// event so the UI can render one chip-row per comment without N round-trips.
export const reactionResponseSchema = z.object({
	id: z.string().uuid(),
	eventId: z.number().int(),
	actorId: z.string().uuid(),
	emoji: z.string(),
	createdAt: z.string(),
})

export const reactionsByObjectResponseSchema = z.object({
	// Map keyed by event_id (stringified — JSON object keys are strings) to the
	// flat reaction list on that event. Returning a map lets the client look up
	// a comment's reactions in O(1) without re-grouping a flat array.
	reactionsByEventId: z.record(z.string(), z.array(reactionResponseSchema)),
})

export type ToggleReactionBody = z.infer<typeof toggleReactionBodySchema>
export type ReactionResponse = z.infer<typeof reactionResponseSchema>
export type ReactionsByObjectResponse = z.infer<typeof reactionsByObjectResponseSchema>
