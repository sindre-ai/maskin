import { z } from 'zod'
import { SAFE_METADATA_FIELD_NAME_RE } from './objects'
import { safeJsonValue } from './primitives'

export const triggerTypeSchema = z.enum(['cron', 'event', 'reminder'])

// A cron `scope` filter narrows the pass to the objects the target agent should
// act on. When set, the trigger runner pre-queries `objects` and skips session
// creation entirely on a zero-row pass — no session, no `trigger_fired` event.
// Matched rows are appended to the action prompt so the agent gets the batch
// without a round-trip through get_objects.
//
// `metadata_eq` keys and `metadata_before_now` are inlined into `sql.raw`, so
// they're pinned to `SAFE_METADATA_FIELD_NAME_RE` (same contract the
// `metadata.<field>` filter on `/api/objects` enforces). Values in
// `metadata_eq` are always parameter-bound.
const safeFieldName = z.string().regex(SAFE_METADATA_FIELD_NAME_RE)
export const cronScopeSchema = z.object({
	entity_type: z.string().min(1),
	metadata_eq: z.record(safeFieldName, z.string()).optional(),
	metadata_before_now: safeFieldName.optional(),
})

export const cronConfigSchema = z.object({
	expression: z.string(),
	scope: cronScopeSchema.optional(),
})

export const conditionOperatorSchema = z.enum([
	'equals',
	'not_equals',
	'greater_than',
	'less_than',
	'before',
	'after',
	'within_days',
	'is_set',
	'is_not_set',
	'contains',
	'in',
	'not_in',
])

export const triggerConditionSchema = z.object({
	field: z.string(),
	operator: conditionOperatorSchema,
	value: safeJsonValue.optional(),
})

export const eventConfigSchema = z.object({
	entity_type: z.string(),
	action: z.string(),
	filter: z.record(z.string(), safeJsonValue).optional(),
	conditions: z.array(triggerConditionSchema).optional(),
	from_status: z.string().optional(),
	to_status: z.string().optional(),
})

export const reminderConfigSchema = z.object({
	scheduled_at: z.string().datetime(),
})

export const triggerConfigSchema = z.union([
	cronConfigSchema,
	eventConfigSchema,
	reminderConfigSchema,
])

const baseTriggerFields = {
	id: z.string().uuid().optional(),
	name: z.string().min(1),
	action_prompt: z.string().min(1),
	target_actor_id: z.string().uuid(),
	enabled: z.boolean().default(true),
}

export const createTriggerSchema = z.discriminatedUnion('type', [
	z.object({
		...baseTriggerFields,
		type: z.literal('cron'),
		config: cronConfigSchema,
	}),
	z.object({
		...baseTriggerFields,
		type: z.literal('event'),
		config: eventConfigSchema,
	}),
	z.object({
		...baseTriggerFields,
		type: z.literal('reminder'),
		config: reminderConfigSchema,
	}),
])

export const updateTriggerSchema = z.object({
	name: z.string().min(1).optional(),
	config: triggerConfigSchema.optional(),
	action_prompt: z.string().min(1).optional(),
	target_actor_id: z.string().uuid().optional(),
	enabled: z.boolean().optional(),
})

export const triggerParamsSchema = z.object({
	id: z.string().uuid(),
})

// HTTP shape returned by `GET /api/triggers`. Lives here so the MCP server and
// web client both consume the same canonical fields — a rename like
// `targetActorId → target_actor_id` would otherwise null out trigger owners in
// the heroCard payload without a compile error.
export const triggerResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	name: z.string(),
	type: z.string(),
	config: z.record(z.string(), z.unknown()).nullable(),
	actionPrompt: z.string(),
	targetActorId: z.string().uuid(),
	enabled: z.boolean(),
	createdBy: z.string().uuid(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})

export type TriggerResponse = z.infer<typeof triggerResponseSchema>
