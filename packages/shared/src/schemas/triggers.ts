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

// `writes`, `stops_for_you` and `skill` are reader-only fields: the trigger
// detail page renders a section for each when it is present, and nothing in
// the matching logic reads them. They are declared here because zod strips
// unknown keys — without them a caller can store the section content but the
// page can never show it.
const triggerReaderFields = {
	writes: z
		.array(
			z.object({
				act: z.string().optional(),
				type: z.string().optional(),
				state: z.string().optional(),
			}),
		)
		.optional(),
	stops_for_you: z.string().optional(),
	skill: z.string().optional(),
}

export const eventConfigSchema = z.object({
	entity_type: z.string(),
	action: z.string(),
	filter: z.record(z.string(), safeJsonValue).optional(),
	conditions: z.array(triggerConditionSchema).optional(),
	from_status: z.string().optional(),
	to_status: z.string().optional(),
	...triggerReaderFields,
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

// `type` is optional (a PATCH may only touch `enabled`, `name`, etc.) but when
// present it must arrive together with a `config` that matches its shape —
// otherwise a caller could flip `type` to 'event' while leaving a stale cron
// `config` (or vice versa) on the row, which is exactly the corruption this
// schema previously allowed by omitting `type` entirely.
export const configSchemaForType: Record<z.infer<typeof triggerTypeSchema>, z.ZodTypeAny> = {
	cron: cronConfigSchema,
	event: eventConfigSchema,
	reminder: reminderConfigSchema,
}

export const updateTriggerSchema = z
	.object({
		name: z.string().min(1).optional(),
		type: triggerTypeSchema.optional(),
		config: triggerConfigSchema.optional(),
		action_prompt: z.string().min(1).optional(),
		target_actor_id: z.string().uuid().optional(),
		enabled: z.boolean().optional(),
		// Narrow escape hatch for the Slack auto-resume UX (PR D). When true,
		// the PATCH handler strips `auto_paused` from the row's metadata jsonb —
		// the resume needs the field REMOVED (not just skipped) so the next
		// `member_left_channel` handler pass captures a fresh `previous_enabled`
		// instead of inheriting a stale one. Deliberately narrower than
		// exposing a generic `metadata` write on this endpoint; other keys on
		// `metadata` (notably PR B's `slack_setup`) are preserved.
		clear_auto_paused: z.boolean().optional(),
	})
	.superRefine((data, ctx) => {
		if (!data.type) return
		if (!data.config) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'config is required when changing type',
				path: ['config'],
			})
			return
		}
		const result = configSchemaForType[data.type].safeParse(data.config)
		if (!result.success) {
			for (const issue of result.error.issues) {
				ctx.addIssue({ ...issue, path: ['config', ...issue.path] })
			}
		}
	})

export const triggerParamsSchema = z.object({
	id: z.string().uuid(),
})

// Slack trigger-save setup outcomes, persisted on `triggers.metadata.slack_setup`.
// Written by `runSlackTriggerSetup` and read by `SlackTriggerSetupStatus` on the
// trigger detail form. Additive on an existing jsonb column — no migration.
export const slackSetupJoinStatusSchema = z.enum([
	'joined',
	'already_in',
	'not_public',
	'not_authed',
	'channel_not_found',
	'restricted_action',
	'error',
])

export const slackSetupJoinAttemptSchema = z.object({
	channel_id: z.string(),
	status: slackSetupJoinStatusSchema,
	error: z.string().optional(),
	attempted_at: z.string(),
})

export const slackSetupMetadataSchema = z.object({
	channel_ids: z.array(z.string()),
	join_attempts: z.array(slackSetupJoinAttemptSchema),
	confirmation_posted_at: z.record(z.string(), z.string()).optional(),
	last_setup_at: z.string(),
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
	// Additive JSONB — carries `slack_setup` from `runSlackTriggerSetup` and
	// (in later PRs) `auto_paused` from the `member_left_channel` handler.
	// Nullable everywhere; the form only reads it, never writes it.
	metadata: z.record(z.string(), z.unknown()).nullable().optional(),
	createdBy: z.string().uuid(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})

export type TriggerResponse = z.infer<typeof triggerResponseSchema>
export type SlackSetupJoinStatus = z.infer<typeof slackSetupJoinStatusSchema>
export type SlackSetupJoinAttempt = z.infer<typeof slackSetupJoinAttemptSchema>
export type SlackSetupMetadata = z.infer<typeof slackSetupMetadataSchema>
