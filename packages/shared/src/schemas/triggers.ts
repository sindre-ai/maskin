import { z } from 'zod'
import { safeJsonValue } from './primitives'

export const triggerTypeSchema = z.enum(['cron', 'event', 'reminder'])

export const cronConfigSchema = z.object({
	expression: z.string(),
	timezone: z.string().optional(),
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
