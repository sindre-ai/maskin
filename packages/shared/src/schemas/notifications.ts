import { z } from 'zod'
import { safeJsonValue } from './primitives'

export const notificationTypeSchema = z.enum([
	'needs_input',
	'recommendation',
	'good_news',
	'alert',
])

export const notificationStatusSchema = z.enum(['pending', 'seen', 'resolved', 'dismissed'])

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

const commaSeparatedStatuses = z
	.string()
	.transform((s) =>
		s
			.split(',')
			.map((v) => v.trim())
			.filter(Boolean),
	)
	.pipe(z.array(notificationStatusSchema).min(1))

export const notificationQuerySchema = z.object({
	status: commaSeparatedStatuses.optional(),
	type: z.string().optional(),
	object_id: z.string().uuid().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})
