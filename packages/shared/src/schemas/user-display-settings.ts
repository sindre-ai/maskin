import { z } from 'zod'
import { objectTypeSchema } from './objects'

// Bounded shape the Display panel writes. Each field maps 1:1 to a panel
// section (View, Ordering, Grouping, Filters, Properties). Constraining
// `settings` to this shape caps the JSON payload size at the boundary —
// closes the unbounded-record finding from Task 5's review on the upsert
// route.
const filterStringSchema = z.string().min(1).max(128)
// Column ids include dynamic `metadata.<field_name>` keys, so the cap is
// looser than a filter value but still finite.
const columnIdSchema = z.string().min(1).max(256)

export const displaySettingsBodySchema = z
	.object({
		view: z.enum(['list', 'board']).optional(),
		sort: filterStringSchema.optional(),
		order: z.enum(['asc', 'desc']).optional(),
		groupBy: filterStringSchema.nullable().optional(),
		filters: z
			.object({
				status: filterStringSchema.optional(),
				owner: filterStringSchema.optional(),
			})
			.strict()
			.optional(),
		columnVisibility: z.record(columnIdSchema, z.boolean()).optional(),
	})
	.strict()

export const userDisplaySettingsParamsSchema = z.object({
	object_type: objectTypeSchema,
})

export const upsertUserDisplaySettingsBodySchema = z.object({
	settings: displaySettingsBodySchema,
})

export const userDisplaySettingsResponseSchema = z.object({
	object_type: objectTypeSchema,
	name: z.string(),
	settings: displaySettingsBodySchema,
	updated_at: z.string(),
})

export const listUserDisplaySettingsResponseSchema = z.object({
	items: z.array(userDisplaySettingsResponseSchema),
})

export type DisplaySettingsBody = z.infer<typeof displaySettingsBodySchema>
