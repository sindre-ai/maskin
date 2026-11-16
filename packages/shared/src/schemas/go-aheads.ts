import { z } from 'zod'

/** How a go-ahead reached the system: a person's chat message, or a person approving a card. */
export const GO_AHEAD_VIAS = ['chat', 'card'] as const
export type GoAheadVia = (typeof GO_AHEAD_VIAS)[number]

const recordGoAheadBaseSchema = z.object({
	via: z
		.enum(GO_AHEAD_VIAS)
		.describe('chat: quote a person’s message. card: a person approved a card.'),
	message_id: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'via chat: the id of the person’s chat message that gave the go-ahead (a message in a chat about this job). Not allowed via card.',
		),
})

/** The fields of recordGoAheadSchema, for tool definitions that spread a shape. */
export const recordGoAheadShape = recordGoAheadBaseSchema.shape

/**
 * Record a person's go-ahead on a job. via chat: quote the message in which a person said to keep
 * going without asking (message_id). The message must exist, be written by a person, and sit in a
 * chat about this job. via card: the caller is the person who approved a card; only a person may
 * call it that way. An agent can never grant a go-ahead on its own say-so.
 */
export const recordGoAheadSchema = recordGoAheadBaseSchema.superRefine((value, ctx) => {
	if (value.via === 'chat' && value.message_id === undefined) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['message_id'],
			message: 'via chat needs message_id: quote the person’s message',
		})
	}
	if (value.via === 'card' && value.message_id !== undefined) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['message_id'],
			message: 'message_id is only for via chat',
		})
	}
})

export const goAheadResponseSchema = z.object({
	id: z.string().uuid(),
	object_id: z.string().uuid(),
	granted_by: z.string().uuid(),
	granted_by_name: z.string(),
	via: z.enum(GO_AHEAD_VIAS),
	message_id: z.number().nullable(),
	granted_at: z.string(),
})

export type RecordGoAheadInput = z.infer<typeof recordGoAheadSchema>
export type GoAheadResponse = z.infer<typeof goAheadResponseSchema>
