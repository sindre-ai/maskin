import { z } from 'zod'
import { safeJsonValue, safeMetadataSchema } from './primitives'

export const notificationTypeSchema = z.enum([
	'needs_input',
	'recommendation',
	'good_news',
	'alert',
])

export const notificationStatusSchema = z.enum(['pending', 'seen', 'resolved', 'dismissed'])

export const createNotificationSchema = z.object({
	type: notificationTypeSchema,
	title: z.string().min(1),
	content: z.string().optional(),
	metadata: safeMetadataSchema.optional(),
	source_actor_id: z.string().uuid(),
	target_actor_id: z.string().uuid().optional(),
	object_id: z.string().uuid().optional(),
	session_id: z.string().uuid().optional(),
})

export const updateNotificationSchema = z.object({
	status: notificationStatusSchema.optional(),
	metadata: safeMetadataSchema.optional(),
})

export const respondNotificationSchema = z.object({
	response: safeJsonValue,
})

const commaSeparatedStatuses = z
	.string()
	.transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
	.pipe(z.array(notificationStatusSchema).min(1))

export const notificationQuerySchema = z.object({
	status: commaSeparatedStatuses.optional(),
	type: z.string().optional(),
	object_id: z.string().uuid().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})
