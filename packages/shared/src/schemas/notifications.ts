import { z } from 'zod'
import { safeJsonValue } from './primitives'

export const notificationTypeSchema = z.enum([
	'needs_input',
	'recommendation',
	'good_news',
	'alert',
])

export const notificationStatusSchema = z.enum([
	'pending',
	'seen',
	'resolved',
	'dismissed',
	'expired',
])

// Shape of a single action button in metadata.actions
export const notificationActionSchema = z.object({
	label: z.string().min(1).describe('Button text shown to the human'),
	response: z
		.unknown()
		.optional()
		.describe('Value routed back to the agent when clicked (e.g. "merged_continue")'),
	variant: z.enum(['default', 'outline', 'ghost', 'destructive']).optional(),
	navigate: z
		.object({
			to: z.string(),
			id: z.string().optional(),
		})
		.optional(),
})

// Shape of a single option in metadata.options (for structured input pickers)
export const notificationOptionSchema = z.object({
	label: z.string().min(1),
	value: z.string().min(1),
	description: z.string().optional(),
	// Marks the option the expiry sweeper should resolve to when the notification
	// elapses without a decision. The sweeper picks the option whose `value`
	// matches the `default_action` column, but this flag lets UIs and MCP callers
	// declare intent alongside the option list itself.
	default: z.boolean().optional(),
})

// Reversibility hint on a decision — drives the 6s reverse-window UX and lets
// the For You feed sort irreversible actions above reversible ones.
export const notificationReversibilitySchema = z.enum(['reversible', 'irreversible'])

// Blast-radius hint on a decision — how much surface a mistake would touch.
// Kept coarse on purpose; renderers colour-code by bucket.
export const notificationBlastRadiusSchema = z.enum(['local', 'workspace', 'external'])

// Artifact reference in metadata.artifacts[]. Uses `fileId` (a UUID pointing at
// the `files` table) rather than an `attached` relationship edge — see the
// Architect spec on the parent bet for why.
export const notificationArtifactSchema = z.object({
	kind: z.string().min(1),
	fileId: z.string().uuid(),
	title: z.string().min(1),
})

// Accept either a native array OR a JSON-stringified array, and coerce to array.
// Agents sometimes stringify; we transparently parse instead of rejecting.
//
// Uses preprocess (parse string → value, then validate once) rather than a union
// of [array, string]. A union would fall through to the string branch when a
// native array's items fail validation, producing confusing "expected string"
// errors. Preprocess lets the single downstream `z.array(item)` own all errors.
function arrayOrJsonString<T extends z.ZodTypeAny>(item: T) {
	return z.preprocess((val) => {
		if (typeof val !== 'string') return val
		try {
			return JSON.parse(val)
		} catch {
			return val
		}
	}, z.array(item))
}

// Notification metadata is richer than generic metadata: it may contain nested
// objects (actions, options) to drive the UI. Known keys are typed; other keys
// pass through as free-form JSON-serializable values.
export const notificationMetadataSchema = z
	.object({
		actions: arrayOrJsonString(notificationActionSchema).optional(),
		options: arrayOrJsonString(notificationOptionSchema).optional(),
		input_type: z.enum(['confirmation', 'single_choice', 'multiple_choice', 'text']).optional(),
		question: z.string().optional(),
		placeholder: z.string().optional(),
		multiline: z.boolean().optional(),
		suggestion: z.string().optional(),
		urgency_label: z.string().optional(),
		meta_text: z.string().optional(),
		tags: z.array(z.string()).optional(),
		// Decision-support fields backing the schema wall (parent bet AC 1).
		// Length caps keep For You cards scannable and enforce the compression
		// the schema wall exists to force.
		asked: z.string().max(120).optional(),
		found: z.string().max(280).optional(),
		recommendation: z.string().max(160).optional(),
		attention_needed: z.boolean().optional(),
		reversibility: notificationReversibilitySchema.optional(),
		blast_radius: notificationBlastRadiusSchema.optional(),
		// Groups same-object cards for bulk-respond in the feed.
		group_key: z.string().optional(),
		artifacts: arrayOrJsonString(notificationArtifactSchema).optional(),
	})
	.catchall(z.union([safeJsonValue, z.record(z.string(), z.unknown()), z.array(z.unknown())]))

export const createNotificationSchema = z.object({
	type: notificationTypeSchema,
	title: z.string().min(1),
	content: z.string().optional(),
	metadata: notificationMetadataSchema.optional(),
	source_actor_id: z.string().uuid(),
	target_actor_id: z.string().uuid().optional(),
	object_id: z.string().uuid().optional(),
	session_id: z.string().uuid().optional(),
})

export const updateNotificationSchema = z.object({
	status: notificationStatusSchema.optional(),
	metadata: notificationMetadataSchema.optional(),
})

export const respondNotificationSchema = z.object({
	response: safeJsonValue,
})

// Resolves N notifications in a single request. The ids the client sends are
// whatever the For You feed collapsed under one group_key / objectId — the
// server wraps the same per-id `respond` logic in a single txn and dedupes
// source-agent wakes so one batch = one wake per unique sourceActorId.
export const bulkRespondNotificationSchema = z.object({
	ids: z.array(z.string().uuid()).min(1).max(100),
	response: safeJsonValue,
})

// Explicit 6s undo. The server enforces the window against `resolvedAt`
// (server clock), so this schema carries no client-supplied timestamp.
export const reverseNotificationSchema = z.object({})

const commaSeparatedStatuses = z
	.string()
	.transform((s) =>
		s
			.split(',')
			.map((v) => v.trim())
			.filter(Boolean),
	)
	.pipe(z.array(notificationStatusSchema).min(1))

// Accepts 'true'/'false'/'1'/'0' and coerces to a boolean. Notifications set
// `metadata.attention_needed` per the schema wall — the For You feed uses
// this filter to surface only the attention-required subset.
const booleanQueryParam = z.union([z.boolean(), z.string()]).transform((value) => {
	if (typeof value === 'boolean') return value
	return value === 'true' || value === '1'
})

export const notificationQuerySchema = z.object({
	status: commaSeparatedStatuses.optional(),
	type: z.string().optional(),
	object_id: z.string().uuid().optional(),
	attention_needed: booleanQueryParam.optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})
