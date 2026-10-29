import { z } from 'zod'
import { SAFE_METADATA_FIELD_NAME_RE } from './objects'

/**
 * Read-only aggregation over objects — the one query shape behind the MCP
 * `query_data` tool, `GET /api/data/query`, and the data bridge a custom loop
 * view calls through `window.maskin.query(name)`. Aggregation runs in SQL; a
 * caller only ever gets grouped numbers back, never object rows.
 */

/** Most object rows one query scans. Past it the result is flagged `rows_truncated`. */
export const DATA_QUERY_MAX_ROWS = 10_000

/** Most groups one query returns. Past it the result is flagged `groups_truncated`. */
export const DATA_QUERY_MAX_GROUPS = 50

/** Most metadata equality filters one query may carry. */
export const DATA_QUERY_MAX_METADATA_FILTERS = 10

// A function, not a shared constant: the MCP tool schemas must not contain a $ref, and
// zod-to-json-schema emits one when the same schema instance appears twice.
const metadataField = () =>
	z
		.string()
		.max(64)
		.regex(SAFE_METADATA_FIELD_NAME_RE, 'Metadata field names are letters, digits and underscores')

const GROUP_BY_RE = /^(status|type|metadata\.[a-zA-Z][a-zA-Z0-9_]*)$/

export const dataQueryFiltersSchema = z
	.object({
		status: z
			.union([z.string().min(1).max(64), z.array(z.string().min(1).max(64)).min(1).max(20)])
			.optional()
			.describe('One status, or a list of statuses to match.'),
		metadata: z
			.record(metadataField(), z.union([z.string().max(256), z.number(), z.boolean()]))
			.refine((m) => Object.keys(m).length <= DATA_QUERY_MAX_METADATA_FILTERS, {
				message: `At most ${DATA_QUERY_MAX_METADATA_FILTERS} metadata filters`,
			})
			.optional()
			.describe('Exact-match filters on metadata fields, e.g. { "priority": "P1" }.'),
		created_after: z.string().datetime().optional(),
		created_before: z.string().datetime().optional(),
		updated_after: z.string().datetime().optional(),
		updated_before: z.string().datetime().optional(),
	})
	.strict()

export const dataQuerySpecSchema = z
	.object({
		scope: z
			.union([z.literal('workspace'), z.string().uuid()])
			.default('workspace')
			.describe('"workspace" for every object, or a loop id to count only that loop\'s members.'),
		type: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
			.describe('Object type to query, e.g. "task", "bet", "insight" or a custom type.'),
		filters: dataQueryFiltersSchema.optional(),
		group_by: z
			.string()
			.max(80)
			.regex(GROUP_BY_RE, 'group_by is "status", "type" or "metadata.<field>"')
			.optional()
			.describe('"status", "type" or "metadata.<field>". Omit for one overall total.'),
		aggregate: z
			.object({
				op: z.enum(['count', 'sum', 'avg']),
				field: metadataField()
					.optional()
					.describe('Numeric metadata field to sum or average. Required for sum and avg.'),
			})
			.strict()
			.refine((a) => a.op === 'count' || !!a.field, {
				message: 'sum and avg need a numeric metadata field',
				path: ['field'],
			})
			.optional()
			.describe('Defaults to { op: "count" }.'),
	})
	.strict()

export type DataQuerySpec = z.infer<typeof dataQuerySpecSchema>
export type DataQueryInput = z.input<typeof dataQuerySpecSchema>

export const dataQueryResultSchema = z.object({
	groups: z.array(
		z.object({
			key: z.string().nullable(),
			count: z.number(),
			/** The count for `count`, else the sum/average (null when no row had a number). */
			value: z.number().nullable(),
		}),
	),
	total: z.object({ count: z.number(), value: z.number().nullable() }),
	rows_truncated: z.boolean(),
	groups_truncated: z.boolean(),
})

export type DataQueryResult = z.infer<typeof dataQueryResultSchema>
