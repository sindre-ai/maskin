import { z } from 'zod'

export const createRelationshipSchema = z.object({
	source_type: z.string(),
	source_id: z.string().uuid(),
	target_type: z.string(),
	target_id: z.string().uuid(),
	type: z.string(),
})

export const relationshipQuerySchema = z.object({
	source_id: z.string().uuid().optional(),
	target_id: z.string().uuid().optional(),
	type: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})

export const relationshipParamsSchema = z.object({
	id: z.string().uuid(),
})
