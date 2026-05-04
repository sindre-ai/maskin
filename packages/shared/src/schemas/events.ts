import { z } from 'zod'

export const eventQuerySchema = z.object({
	entity_type: z.string().optional(),
	entity_id: z.string().uuid().optional(),
	action: z.string().optional(),
	since: z.coerce.number().optional(),
	after: z.string().datetime({ offset: true }).optional(),
	before: z.string().datetime({ offset: true }).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})

export const createCommentSchema = z.object({
	entity_id: z.string().uuid(),
	content: z.string().min(1).max(10000),
	mentions: z.array(z.string().uuid()).max(50).optional(),
	parent_event_id: z.number().int().positive().optional(),
})
