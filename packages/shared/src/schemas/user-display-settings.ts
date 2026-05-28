import { z } from 'zod'
import { objectTypeSchema } from './objects'

export const displaySettingsPayloadSchema = z.record(z.string(), z.unknown())

export const userDisplaySettingsParamsSchema = z.object({
	object_type: objectTypeSchema,
})

export const upsertUserDisplaySettingsBodySchema = z.object({
	settings: displaySettingsPayloadSchema,
})

export const userDisplaySettingsResponseSchema = z.object({
	object_type: objectTypeSchema,
	name: z.string(),
	settings: displaySettingsPayloadSchema,
	updated_at: z.string(),
})

export const listUserDisplaySettingsResponseSchema = z.object({
	items: z.array(userDisplaySettingsResponseSchema),
})
