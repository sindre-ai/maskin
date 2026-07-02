import { z } from 'zod'
import { objectTypeSchema } from './objects'

// Sentinel slot for the Objects page's "All" tab, which has no concrete
// object type but still needs a per-actor row to persist display-panel
// state (column visibility, etc.). The double-underscore prefix is
// unreachable through `objectTypeSchema` (which requires `[a-z]` start),
// so this can never collide with a real workspace-defined type.
export const ALL_TYPES_KEY = '__all__'

// Accepts a real object type OR the All-tab sentinel. Used only on the
// user-display-settings endpoint — the rest of the codebase keeps the
// strict `objectTypeSchema`.
export const displaySettingsTypeKeySchema = z.union([objectTypeSchema, z.literal(ALL_TYPES_KEY)])

// Bounded shape the Display panel writes. Each field maps 1:1 to a panel
// section (View, Ordering, Grouping, Filters, Properties). Constraining
// `settings` to this shape caps the JSON payload size at the boundary —
// closes the unbounded-record finding from Task 5's review on the upsert
// route.
const filterStringSchema = z.string().min(1).max(512)
// Column ids include dynamic `metadata.<field_name>` keys, so the cap is
// looser than a filter value but still finite.
const columnIdSchema = z.string().min(1).max(256)
// Worst-case payload size: 200 * (256 key + 5 value + JSON quoting) ≈ 53 KB.
// Comfortably under any reasonable body limit and well above the realistic
// upper bound (the objects table has a few dozen columns at most).
const COLUMN_VISIBILITY_MAX_ENTRIES = 200

export const displaySettingsBodySchema = z
	.object({
		view: z.enum(['list', 'board']).optional(),
		sort: filterStringSchema.optional(),
		order: z.enum(['asc', 'desc']).optional(),
		groupBy: filterStringSchema.nullable().optional(),
		filters: z
			.object({
				status: filterStringSchema.optional(),
				driver: filterStringSchema.optional(),
			})
			.strict()
			.optional(),
		columnVisibility: z
			.record(columnIdSchema, z.boolean())
			.refine((v) => Object.keys(v).length <= COLUMN_VISIBILITY_MAX_ENTRIES, {
				message: `columnVisibility may have at most ${COLUMN_VISIBILITY_MAX_ENTRIES} entries`,
			})
			.optional(),
	})
	.strict()

export const userDisplaySettingsParamsSchema = z.object({
	object_type: displaySettingsTypeKeySchema,
})

export const upsertUserDisplaySettingsBodySchema = z.object({
	settings: displaySettingsBodySchema,
})

export const userDisplaySettingsResponseSchema = z.object({
	object_type: displaySettingsTypeKeySchema,
	name: z.string(),
	settings: displaySettingsBodySchema,
	updated_at: z.string(),
})

export const listUserDisplaySettingsResponseSchema = z.object({
	items: z.array(userDisplaySettingsResponseSchema),
})

export type DisplaySettingsBody = z.infer<typeof displaySettingsBodySchema>
