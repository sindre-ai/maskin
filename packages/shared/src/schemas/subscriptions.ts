import { z } from 'zod'

// v1 only ships object subscriptions, but storage is entity-generic. Add
// 'thread' | 'session' | … here when those entities become subscribable.
export const subscribableEntityTypeSchema = z.enum(['object'])

export const subscribeBodySchema = z.object({
	entity_type: subscribableEntityTypeSchema,
	entity_id: z.string().uuid(),
})

export const unsubscribeBodySchema = subscribeBodySchema

export const subscribersQuerySchema = z.object({
	entity_type: subscribableEntityTypeSchema,
	entity_id: z.string().uuid(),
})

export const markReadBodySchema = z.object({
	entity_type: subscribableEntityTypeSchema,
	entity_id: z.string().uuid(),
	// events.id is a bigserial; we accept positive integers and refuse to move
	// the high-water-mark backward in the route handler.
	last_event_id: z.coerce.number().int().positive(),
})

// mark-unread is a Slack-style toggle: it deletes the actor's read_state row
// so every unread event on the entity reappears in the feed. No high-water
// mark to send — the whole row is dropped.
export const markUnreadBodySchema = z.object({
	entity_type: subscribableEntityTypeSchema,
	entity_id: z.string().uuid(),
})

export const unreadQuerySchema = z.object({
	entity_type: subscribableEntityTypeSchema.optional(),
	// When true, keep recently-read entities in the feed alongside unread ones.
	// A card is "recently read" if it has zero unread events but its latest
	// matching event landed within the last 48 hours. Default off so the
	// sidebar unread badge and other callers stay unread-only.
	include_recently_read: z
		.enum(['true', 'false'])
		.optional()
		.transform((v) => v === 'true'),
})
