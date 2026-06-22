import { z } from 'zod'

export const conversationTypeSchema = z.enum(['dm', 'room'])
export type ConversationType = z.infer<typeof conversationTypeSchema>

export const createConversationSchema = z.object({
	title: z.string().nullable().optional(),
	type: conversationTypeSchema,
	participant_actor_ids: z.array(z.string().uuid()).min(1),
})
export type CreateConversationInput = z.infer<typeof createConversationSchema>

export const participantActorSchema = z.object({
	actorId: z.string().uuid(),
	name: z.string(),
	type: z.string(),
	isOnline: z.boolean(),
})
export type ParticipantActor = z.infer<typeof participantActorSchema>

export const conversationResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	title: z.string().nullable(),
	type: conversationTypeSchema,
	lastMessagePreview: z.string().nullable(),
	lastActivityAt: z.string().nullable(),
	createdAt: z.string(),
	participantCount: z.number().int(),
	unreadCount: z.number().int(),
	participants: z.array(participantActorSchema),
})
export type ConversationResponse = z.infer<typeof conversationResponseSchema>

export const messageResponseSchema = z.object({
	id: z.string().uuid(),
	conversationId: z.string().uuid(),
	actorId: z.string().uuid(),
	content: z.string(),
	createdAt: z.string(),
})
export type MessageResponse = z.infer<typeof messageResponseSchema>

export const messagesQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})
export type MessagesQuery = z.infer<typeof messagesQuerySchema>

export const MAX_MESSAGE_MENTIONS = 20

export const sendMessageSchema = z.object({
	content: z.string().min(1).max(10000),
	mentions: z.array(z.string().uuid()).max(MAX_MESSAGE_MENTIONS).optional(),
})
export type SendMessageInput = z.infer<typeof sendMessageSchema>

export const updateConversationSchema = z.object({
	title: z.string().min(1).max(255).nullable(),
})
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>

export const addParticipantSchema = z.object({
	actor_id: z.string().uuid(),
})
export type AddParticipantInput = z.infer<typeof addParticipantSchema>

export const participantResponseSchema = z.object({
	conversationId: z.string().uuid(),
	actorId: z.string().uuid(),
	unreadCount: z.number().int(),
	lastReadAt: z.string().nullable(),
})
export type ParticipantResponse = z.infer<typeof participantResponseSchema>
