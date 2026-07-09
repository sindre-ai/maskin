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
	object_id: z.string().uuid().optional(),
	type: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
	order: z.enum(['asc', 'desc']).optional(),
	// Snapshot-consistent cursor pagination — mirrors `objectQuerySchema`.
	// When `snapshot_at` is set, the server applies `created_at <= snapshot_at`
	// and switches to `(created_at, id)` keyset order. `cursor_created_at` +
	// `cursor_id` must be paired; a lone `cursor_id` is silently ignored.
	snapshot_at: z.string().datetime().optional(),
	cursor_created_at: z.string().datetime().optional(),
	cursor_id: z.string().uuid().optional(),
})

export const relationshipParamsSchema = z.object({
	id: z.string().uuid(),
})
