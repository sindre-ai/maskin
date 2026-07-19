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
// Metadata filter keys are workspace-defined field names, same bound as
// columnIdSchema; realistic field-definition counts per type are a handful.
const METADATA_FILTERS_MAX_ENTRIES = 50
// TanStack Table row ids for grouping look like `metadata.<field>:<value>`;
// the same 256-char bound as columnIdSchema comfortably fits any realistic
// composite key.
const rowIdSchema = z.string().min(1).max(256)
// Group-expansion state can hold one entry per group row rendered on the
// list; the same bound as columnVisibility keeps payload size finite while
// far exceeding any realistic group count.
const GROUP_EXPANDED_MAX_ENTRIES = 200

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
				metadata: z
					.record(columnIdSchema, filterStringSchema)
					.refine((v) => Object.keys(v).length <= METADATA_FILTERS_MAX_ENTRIES, {
						message: `metadata filters may have at most ${METADATA_FILTERS_MAX_ENTRIES} entries`,
					})
					.optional(),
			})
			.strict()
			.optional(),
		columnVisibility: z
			.record(columnIdSchema, z.boolean())
			.refine((v) => Object.keys(v).length <= COLUMN_VISIBILITY_MAX_ENTRIES, {
				message: `columnVisibility may have at most ${COLUMN_VISIBILITY_MAX_ENTRIES} entries`,
			})
			.optional(),
		timelineView: z.enum(['timeline', 'table']).optional(),
		groupExpanded: z
			.record(rowIdSchema, z.boolean())
			.refine((v) => Object.keys(v).length <= GROUP_EXPANDED_MAX_ENTRIES, {
				message: `groupExpanded may have at most ${GROUP_EXPANDED_MAX_ENTRIES} entries`,
			})
			.optional(),
		firstVisibleRowId: rowIdSchema.nullable().optional(),
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
