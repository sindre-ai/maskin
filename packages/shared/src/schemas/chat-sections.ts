import { z } from 'zod'

/** A person keeps at most this many sections per workspace, so the list stays short enough to read. */
export const CHAT_SECTIONS_MAX_PER_PERSON = 50

export const CHAT_SECTION_NAME_MAX_LENGTH = 60

export const chatSectionNameSchema = z.string().trim().min(1).max(CHAT_SECTION_NAME_MAX_LENGTH)

export const createChatSectionSchema = z.object({
	name: chatSectionNameSchema,
})

/** Rename and fold are the only edits. Order has its own route, chats move through the chat routes. */
export const updateChatSectionSchema = z
	.object({
		name: chatSectionNameSchema.optional(),
		collapsed: z.boolean().optional(),
	})
	.refine((v) => v.name !== undefined || v.collapsed !== undefined, {
		message: 'At least one of name or collapsed must be provided',
	})

/** Every one of the caller's sections, once, in the order they should show. */
export const reorderChatSectionsSchema = z.object({
	ids: z.array(z.string().uuid()).max(CHAT_SECTIONS_MAX_PER_PERSON),
})

export const chatSectionChatParamSchema = z.object({
	id: z.string().uuid(),
	conversationId: z.string().uuid(),
})

export type CreateChatSectionInput = z.infer<typeof createChatSectionSchema>
export type UpdateChatSectionInput = z.infer<typeof updateChatSectionSchema>
