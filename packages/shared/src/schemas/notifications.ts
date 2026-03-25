import { z } from 'zod'

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
	metadata: z.record(z.unknown()).optional(),
	source_actor_id: z.string().uuid(),
	target_actor_id: z.string().uuid().optional(),
	object_id: z.string().uuid().optional(),
	session_id: z.string().uuid().optional(),
})

export const updateNotificationSchema = z.object({
	status: notificationStatusSchema.optional(),
	metadata: z.record(z.unknown()).optional(),
})

export const respondNotificationSchema = z.object({
	response: z.unknown(),
})

export const notificationQuerySchema = z.object({
	status: z.string().optional(),
	type: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})
