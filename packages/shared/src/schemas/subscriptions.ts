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

export const unreadQuerySchema = z.object({
	entity_type: subscribableEntityTypeSchema.optional(),
})
