import { z } from 'zod'
import { safeMetadataSchema } from './primitives'

export const objectTypeSchema = z
	.string()
	.min(1)
	.max(50)
	.regex(/^[a-z][a-z0-9_]*$/)
export type ObjectType = z.infer<typeof objectTypeSchema>

/**
 * Bet statuses that end the bet's normal lifecycle and warrant a one-time
 * watcher signal (unread-feed entry + notification row) rather than routine
 * status-change noise. Matches the default `bet` status list in
 * workspaces.ts's `statuses` schema and the "terminal status" definition
 * used by the Retro & Knowledge Author trigger (packages/db/src/seed.ts).
 * Single source of truth for both apps/dev/src/routes/objects.ts (fan-out
 * gate) and apps/dev/src/routes/subscriptions.ts (unread-feed join) so the
 * two can't independently drift out of sync.
 *
 * `archived` is deliberately NOT in this list — archiving a bet is a silent
 * move that must not surface as an unread-feed row or fan out a retro. If
 * you add a new terminal status, add it here; do NOT add `archived` on the
 * assumption that "terminal" and "in the bet enum" are synonymous.
 */
export const TERMINAL_BET_STATUSES = ['succeeded', 'failed', 'paused'] as const
export type TerminalBetStatus = (typeof TERMINAL_BET_STATUSES)[number]

/**
 * Loop statuses that warrant an unread-feed entry when transitioned into —
 * the "your standing commitment needs attention" signal that mirrors the
 * bet's terminal-status signal. `holding` is deliberately omitted: a Loop
 * settling back into holding is quiet news, not a For You surface. Shared
 * between the briefing composer (`apps/dev/src/services/workspace-briefing.ts`,
 * where these Loops sort ahead of holding) and the unread-feed join
 * (`apps/dev/src/routes/subscriptions.ts`, where a `status_changed` into
 * these values enters the feed). Single source of truth so the two surfaces
 * can't drift.
 */
export const LOOP_ATTENTION_STATUSES = ['at-risk', 'breached'] as const
export type LoopAttentionStatus = (typeof LOOP_ATTENTION_STATUSES)[number]

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
	// Optimistic-concurrency guard. When set, the PATCH UPDATE is predicated on
	// `AND version = <expected_version>` — if a concurrent writer bumped the row
	// between the client's last read and this write, the update matches zero rows
	// and the handler returns 409 with the current server state so the client can
	// reconcile. Also accepted via the `If-Match` header (header takes precedence
	// when both are present). Omit both to opt out of the guard (deprecated
	// last-write-wins path — see Ship Notes on the T2 task).
	expected_version: z.number().int().nonnegative().optional(),
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

/**
 * Field names safe to inline via `sql.raw` in `metadata->>'field'` expressions
 * (sort, groupBy, and `metadata.<field>` equality filters) — must start with a
 * letter and contain only letters, numbers, and underscores. Shared by the
 * backend query builder (`apps/dev/src/routes/objects.ts`) and the frontend
 * route (`objects/index.tsx` search validation, `display-panel.tsx` filter
 * rows) so both sides agree on exactly the same set of filterable field names
 * — a field name accepted by one side and rejected by the other is how a
 * filter can silently vanish instead of erroring.
 */
export const SAFE_METADATA_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/

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

/** Type-agnostic archive visibility flag. Default `false` — reads exclude rows
 *  with `status = 'archived'` regardless of type so archived work stays hidden
 *  from list/search/board unless a caller explicitly opts in. Applies to any
 *  type whose enum carries `archived` (bet today; insight/task later).
 *  Accepts native booleans (MCP JSON body) and query-string tokens `"true"` /
 *  `"1"` (HTTP querystring). Anything else — including `"false"` and `"0"` —
 *  resolves to `false` so archived rows stay hidden by default. */
const includeArchivedSchema = z
	.preprocess((v) => {
		if (typeof v === 'boolean') return v
		if (typeof v === 'string') return v === 'true' || v === '1'
		return false
	}, z.boolean())
	.default(false)
	.describe(
		'When false (the default), rows with `status = "archived"` are excluded regardless of type. Set to `true` to include archived rows — used by surfaces that let a viewer opt in (e.g. the "Include archived" DisplayPanel toggle).',
	)

export const objectQuerySchema = z.object({
	type: objectTypeSchema.optional(),
	status: z.string().optional(),
	driver: z.string().optional(),
	ids: z.string().optional(),
	/** Half-open: rows satisfy `updated_at < updated_before`. Bound excluded. */
	updated_before: z.string().datetime({ offset: true }).optional(),
	/** Half-open: rows satisfy `updated_at > updated_after`. Bound excluded. */
	updated_after: z.string().datetime({ offset: true }).optional(),
	sort: sortFieldSchema,
	order: z.enum(['asc', 'desc']).default('desc'),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
	snapshot_at: snapshotAtSchema,
	cursor_created_at: cursorCreatedAtSchema,
	cursor_id: cursorIdSchema,
	include_archived: includeArchivedSchema,
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
	driver: z.string().optional(),
	/** Half-open: rows satisfy `updated_at > updated_after`. Bound excluded. */
	updated_after: z.string().datetime({ offset: true }).optional(),
	sort: sortFieldSchema,
	order: z.enum(['asc', 'desc']).default('desc'),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce.number().int().min(0).default(0),
	snapshot_at: snapshotAtSchema,
	cursor_created_at: cursorCreatedAtSchema,
	cursor_id: cursorIdSchema,
	include_archived: includeArchivedSchema,
})

export const objectParamsSchema = z.object({
	id: z.string().uuid(),
})
