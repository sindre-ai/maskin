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
	driver: z.string().uuid().optional(),
})

export const updateObjectSchema = z.object({
	title: z.string().optional(),
	content: z.string().optional(),
	status: z.string().optional(),
	metadata: safeMetadataSchema.optional(),
	driver: z.string().uuid().nullable().optional(),
})

/** Bulk-update many objects in one call. Status/owner/metadata are validated
 * per-id against the existing object so a single bad row never poisons the batch
 * — the response shape is `{ results: { id, ok, error? }[] }`. */
export const bulkUpdateObjectsSchema = z.object({
	ids: z.array(z.string().uuid()).min(1).max(200),
	patch: z
		.object({
			status: z.string().optional(),
			driver: z.string().uuid().nullable().optional(),
			metadata: safeMetadataSchema.optional(),
		})
		.refine((p) => p.status !== undefined || p.driver !== undefined || p.metadata !== undefined, {
			message: 'patch must include at least one of status, driver, metadata',
		}),
})

export const bulkUpdateObjectsResultSchema = z.object({
	id: z.string().uuid(),
	ok: z.boolean(),
	error: z.string().optional(),
})

export const bulkUpdateObjectsResponseSchema = z.object({
	results: z.array(bulkUpdateObjectsResultSchema),
})

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
	'driver',
	'createdBy',
] as const

/** Sort field: a built-in column or metadata.<field_name>.
 * Security is enforced server-side in resolveSortColumn — unknown or unsafe fields
 * fall back to the default sort rather than returning 400, so objects never disappear.
 * Avoid .refine() here — ZodEffects breaks @hono/zod-openapi query param extraction. */
const sortFieldSchema = z.string().max(200).default('createdAt')

/** Snapshot-consistent cursor pagination fields (behind `MCP_RESPONSE_SCOPING`).
 *  All three are optional and additive — leaving them unset preserves the
 *  legacy offset/limit shape byte-for-byte. When `snapshot_at` is set, the
 *  server applies `created_at <= snapshot_at` as an upper bound so inserts
 *  after the walk began cannot leak into the paginated stream. When the
 *  keyset pair (`cursor_created_at`, `cursor_id`) is set, the server seeks
 *  strictly past that (created_at, id) tuple in `createdAt` order and
 *  ignores `offset`. */
const snapshotAtSchema = z
	.string()
	.datetime()
	.optional()
	.describe(
		'ISO timestamp captured at first-call time. When set, the server applies `created_at <= snapshot_at` so a row inserted mid-pagination cannot leak into the current walk.',
	)
const cursorIdSchema = z.string().uuid().optional()
const cursorCreatedAtSchema = z
	.string()
	.datetime()
	.optional()
	.describe(
		'Keyset seek: the `created_at` of the last row returned. The server pages strictly past `(cursor_created_at, cursor_id)` in `createdAt` order. Requires `cursor_id`.',
	)

export const objectQuerySchema = z.object({
	type: objectTypeSchema.optional(),
	status: z.string().optional(),
	driver: z.string().optional(),
	ids: z.string().optional(),
	sort: sortFieldSchema,
	order: z.enum(['asc', 'desc']).default('desc'),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
	snapshot_at: snapshotAtSchema,
	cursor_created_at: cursorCreatedAtSchema,
	cursor_id: cursorIdSchema,
})

export const boardObjectQuerySchema = objectQuerySchema.extend({
	type: objectTypeSchema,
	q: z.string().optional(),
	groupBy: z.string().max(200).optional(),
	column: z.string().max(200).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const boardObjectColumnSchema = z.object({
	id: z.string(),
	label: z.string(),
	value: z.string(),
	total: z.number().int().nonnegative(),
	objects: z.array(z.unknown()),
})

export const boardObjectResponseSchema = z.object({
	columns: z.array(boardObjectColumnSchema),
})

export const searchObjectsSchema = z.object({
	q: z.string().min(1),
	type: objectTypeSchema.optional(),
	status: z.string().optional(),
	sort: sortFieldSchema,
	order: z.enum(['asc', 'desc']).default('desc'),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce.number().int().min(0).default(0),
	snapshot_at: snapshotAtSchema,
	cursor_created_at: cursorCreatedAtSchema,
	cursor_id: cursorIdSchema,
})

export const objectParamsSchema = z.object({
	id: z.string().uuid(),
})
