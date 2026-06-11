import { z } from 'zod'
import { safeMetadataSchema } from './primitives'

export const objectTypeSchema = z
	.string()
	.min(1)
	.max(50)
	.regex(/^[a-z][a-z0-9_]*$/)
export type ObjectType = z.infer<typeof objectTypeSchema>

export const createObjectSchema = z.object({
	id: z.string().uuid().optional(),
	type: objectTypeSchema,
	title: z.string().optional(),
	content: z.string().optional(),
	status: z.string(),
	metadata: safeMetadataSchema.optional(),
	owner: z.string().uuid().optional(),
})

export const updateObjectSchema = z.object({
	title: z.string().optional(),
	content: z.string().optional(),
	status: z.string().optional(),
	metadata: safeMetadataSchema.optional(),
	owner: z.string().uuid().nullable().optional(),
})

/** Filter predicate for bulk ops scoped to "all matching this filter". Mirrors
 * the subset of `objectQuerySchema` that selects rows, without the pagination
 * or sort fields — those have no meaning for a bulk mutation. At least one
 * field must be non-empty so an accidental `{}` can't match every row. */
export const objectsFilterSchema = z
	.object({
		q: z.string().min(1).optional(),
		type: objectTypeSchema.optional(),
		status: z.string().optional(),
		owner: z.string().optional(),
		ids: z.string().optional(),
	})
	.refine(
		(f) =>
			f.q !== undefined ||
			f.type !== undefined ||
			f.status !== undefined ||
			f.owner !== undefined ||
			f.ids !== undefined,
		{
			message: 'filter must include at least one of q, type, status, owner, ids',
		},
	)
export type ObjectsFilter = z.infer<typeof objectsFilterSchema>

/** Hard server-side ceiling on how many rows a single filter-scoped bulk op
 * can touch. Acts as a circuit breaker so a runaway predicate can't take down
 * the workspace; the client surfaces the cap in the "select all matching" UI
 * before it ever sends a request. */
export const MAX_BULK_AFFECTED_ROWS = 1000

const bulkPatchSchema = z
	.object({
		status: z.string().optional(),
		owner: z.string().uuid().nullable().optional(),
		metadata: safeMetadataSchema.optional(),
	})
	.refine((p) => p.status !== undefined || p.owner !== undefined || p.metadata !== undefined, {
		message: 'patch must include at least one of status, owner, metadata',
	})

/** Bulk-update many objects in one call. Either `{ scope: 'ids', ids }` (legacy
 * loaded-rows path, capped at 200 to bound the txn) or `{ scope: 'filter', filter }`
 * (operate on every row matching the filter, capped server-side at
 * `MAX_BULK_AFFECTED_ROWS`). The response is per-id so a single bad row never
 * poisons the batch: `{ results: { id, ok, error? }[] }`. */
export const bulkUpdateObjectsSchema = z.discriminatedUnion('scope', [
	z.object({
		scope: z.literal('ids'),
		ids: z.array(z.string().uuid()).min(1).max(200),
		patch: bulkPatchSchema,
	}),
	z.object({
		scope: z.literal('filter'),
		filter: objectsFilterSchema,
		patch: bulkPatchSchema,
	}),
])
export type BulkUpdateObjectsBody = z.infer<typeof bulkUpdateObjectsSchema>

/** Bulk-delete: mirror of bulk-update. Same scope discriminator, no patch. */
export const bulkDeleteObjectsSchema = z.discriminatedUnion('scope', [
	z.object({
		scope: z.literal('ids'),
		ids: z.array(z.string().uuid()).min(1).max(200),
	}),
	z.object({
		scope: z.literal('filter'),
		filter: objectsFilterSchema,
	}),
])
export type BulkDeleteObjectsBody = z.infer<typeof bulkDeleteObjectsSchema>

export const bulkUpdateObjectsResultSchema = z.object({
	id: z.string().uuid(),
	ok: z.boolean(),
	error: z.string().optional(),
})

export const bulkUpdateObjectsResponseSchema = z.object({
	results: z.array(bulkUpdateObjectsResultSchema),
})

/** Returned (with HTTP 422) when a filter-scoped bulk op would touch more rows
 * than `MAX_BULK_AFFECTED_ROWS`. No writes happen — the client uses `count` to
 * tell the user how many rows the predicate matched and `max` to surface the
 * cap. The route emits this nested under the standard `{ error: { ... } }`
 * envelope (see createApiError), so callers read `error.code === 'cap_exceeded'`. */
export const bulkCapExceededDetailsSchema = z.object({
	count: z.number().int().nonnegative(),
	max: z.number().int().positive(),
})
export type BulkCapExceededDetails = z.infer<typeof bulkCapExceededDetailsSchema>

/** Bulk-migrate or delete every object of a given type within a workspace.
 * Used when an extension is removed/disabled, to avoid orphaning rows whose
 * `type` no longer maps to anything in workspace.settings. */
export const migrateObjectTypeSchema = z
	.object({
		fromType: objectTypeSchema,
		mode: z.enum(['migrate', 'delete']),
		toType: objectTypeSchema.optional(),
		statusMap: z.record(z.string(), z.string()).optional(),
	})
	.refine((v) => (v.mode === 'migrate' ? !!v.toType && v.toType !== v.fromType : true), {
		message: 'toType is required for migrate mode and must differ from fromType',
		path: ['toType'],
	})

export const migrateObjectTypeResponseSchema = z.object({
	mode: z.enum(['migrate', 'delete']),
	fromType: z.string(),
	toType: z.string().optional(),
	count: z.number().int().nonnegative(),
})

/** Known built-in sort columns — keep in sync with sortColumns in apps/dev/src/routes/objects.ts */
export const KNOWN_SORT_COLUMNS = [
	'createdAt',
	'updatedAt',
	'title',
	'status',
	'type',
	'owner',
	'createdBy',
] as const

/** Sort field: a built-in column or metadata.<field_name>.
 * Security is enforced server-side in resolveSortColumn — unknown or unsafe fields
 * fall back to the default sort rather than returning 400, so objects never disappear.
 * Avoid .refine() here — ZodEffects breaks @hono/zod-openapi query param extraction. */
const sortFieldSchema = z.string().max(200).default('createdAt')

export const objectQuerySchema = z.object({
	type: objectTypeSchema.optional(),
	status: z.string().optional(),
	owner: z.string().optional(),
	ids: z.string().optional(),
	sort: sortFieldSchema,
	order: z.enum(['asc', 'desc']).default('desc'),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})

export const searchObjectsSchema = z.object({
	q: z.string().min(1),
	type: objectTypeSchema.optional(),
	status: z.string().optional(),
	sort: sortFieldSchema,
	order: z.enum(['asc', 'desc']).default('desc'),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce.number().int().min(0).default(0),
})

export const objectParamsSchema = z.object({
	id: z.string().uuid(),
})
