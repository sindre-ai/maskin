import { z } from 'zod'

export const eventDefinitionSchema = z.object({
	entityType: z.string(),
	actions: z.array(z.string()),
	label: z.string(),
})

export const providerInfoSchema = z.object({
	name: z.string(),
	displayName: z.string(),
	events: z.array(eventDefinitionSchema),
})

export const providerParamsSchema = z.object({
	provider: z.string().min(1),
})

export const integrationParamsSchema = z.object({
	id: z.string().uuid(),
})
