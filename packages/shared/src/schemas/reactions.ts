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

export const reactionsByObjectQuerySchema = z.object({
	object_id: z.string().uuid(),
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
