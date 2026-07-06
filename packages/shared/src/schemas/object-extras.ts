// Static per-type sidecar mapping consumed by /objects/search (route handler
// in apps/dev) and the search_objects MCP tool schema. Table and column names
// are a closed static set so they can be inlined into SQL without escaping;
// values from user input are always parameter-bound.

export type PgCastType = 'text' | 'date' | 'boolean' | 'integer' | 'uuid'

export type SidecarField = {
	column: string
	castType: PgCastType
}

export type Sidecar = {
	table: string
	fields: Record<string, SidecarField>
}

/**
 * Promoted-field map keyed by object type. Column name and cast type mirror
 * the sidecar migration and its Drizzle schema:
 *   - work_bet_extras     → packages/db/drizzle/0047_work_bet_extras.sql (T3)
 *   - work_task_extras    → T4
 *   - work_insight_extras → T5
 *   - crm_customer_extras → packages/db/drizzle/0048_crm_customer_extras.sql (T6)
 */
export const OBJECT_EXTRAS: Record<string, Sidecar> = {
	bet: {
		table: 'work_bet_extras',
		fields: {
			promotion_mode: { column: 'promotion_mode', castType: 'text' },
			review_date: { column: 'review_date', castType: 'date' },
			evidence_quality: { column: 'evidence_quality', castType: 'text' },
			feedback_source: { column: 'feedback_source', castType: 'text' },
			merge_blocked: { column: 'merge_blocked', castType: 'boolean' },
			merge_blocked_since: { column: 'merge_blocked_since', castType: 'date' },
		},
	},
	task: {
		table: 'work_task_extras',
		fields: {
			decision_type: { column: 'decision_type', castType: 'text' },
			explore_phase: { column: 'explore_phase', castType: 'text' },
			explore_candidate: { column: 'explore_candidate', castType: 'boolean' },
			explore_bet_id: { column: 'explore_bet_id', castType: 'uuid' },
		},
	},
	insight: {
		table: 'work_insight_extras',
		fields: {
			theme: { column: 'theme', castType: 'text' },
			strength: { column: 'strength', castType: 'text' },
			anchor: { column: 'anchor', castType: 'text' },
			feedback_source: { column: 'feedback_source', castType: 'text' },
		},
	},
	customer: {
		table: 'crm_customer_extras',
		fields: {
			segment: { column: 'segment', castType: 'text' },
			confidence: { column: 'confidence', castType: 'text' },
			last_validated: { column: 'last_validated', castType: 'date' },
			evidence_count: { column: 'evidence_count', castType: 'integer' },
		},
	},
}

/**
 * Union of every promoted field name across every sidecar. Each entry becomes
 * an optional `<field>_eq` param on /objects/search and the MCP search_objects
 * tool. `feedback_source` is shared between `bet` and `insight`, so the set
 * collapses 18 declarations into 17 unique query params. Kept as a literal
 * tuple so TypeScript can lift the field names to literal string types for
 * schema construction.
 */
export const EXTRAS_FIELD_NAMES = [
	'anchor',
	'confidence',
	'decision_type',
	'evidence_count',
	'evidence_quality',
	'explore_bet_id',
	'explore_candidate',
	'explore_phase',
	'feedback_source',
	'last_validated',
	'merge_blocked',
	'merge_blocked_since',
	'promotion_mode',
	'review_date',
	'segment',
	'strength',
	'theme',
] as const

export type ExtrasFieldName = (typeof EXTRAS_FIELD_NAMES)[number]

/** `<field>_eq` for every entry in EXTRAS_FIELD_NAMES. */
export const EXTRAS_EQ_PARAM_NAMES = EXTRAS_FIELD_NAMES.map(
	(f) => `${f}_eq` as const,
) as readonly `${ExtrasFieldName}_eq`[]

export type ExtrasEqParamName = (typeof EXTRAS_EQ_PARAM_NAMES)[number]

export function isExtrasFieldForType(objectType: string, fieldName: string): boolean {
	const sidecar = OBJECT_EXTRAS[objectType]
	return !!sidecar && fieldName in sidecar.fields
}
