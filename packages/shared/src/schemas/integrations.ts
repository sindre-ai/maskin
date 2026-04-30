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

/**
 * Gmail Pub/Sub push envelope. Google publishes a base64-encoded JSON blob in
 * `message.data` whose decoded shape is `{ emailAddress, historyId }`.
 */
export const gmailPubsubEnvelopeSchema = z.object({
	subscription: z.string(),
	message: z.object({
		data: z.string(),
		messageId: z.string().optional(),
		publishTime: z.string().optional(),
	}),
})

export const gmailPubsubMessageDataSchema = z.object({
	emailAddress: z.string().email(),
	historyId: z.union([z.string(), z.number()]).transform((v) => String(v)),
})
