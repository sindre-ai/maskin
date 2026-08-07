import { z } from 'zod'

export const CONVERSATION_TITLE_MAX_LENGTH = 200
// Chat turns run longer than object comments (COMMENT_MAX_LENGTH in events.ts).
export const MESSAGE_MAX_LENGTH = 8000
export const MAX_CONVERSATION_PARTICIPANTS = 50
export const MESSAGE_MAX_ATTACHMENTS = 10
export const MESSAGE_MAX_MENTIONS = 50

export const createConversationSchema = z.object({
	title: z.string().min(1, 'Title cannot be empty').max(CONVERSATION_TITLE_MAX_LENGTH),
	participant_actor_ids: z.array(z.string().uuid()).max(MAX_CONVERSATION_PARTICIPANTS),
	initial_message: z.string().min(1).max(MESSAGE_MAX_LENGTH).optional(),
})

export const updateConversationSchema = z.object({
	title: z.string().min(1, 'Title cannot be empty').max(CONVERSATION_TITLE_MAX_LENGTH),
})

export const addConversationParticipantsSchema = z.object({
	actor_ids: z.array(z.string().uuid()).min(1).max(MAX_CONVERSATION_PARTICIPANTS),
})

export const conversationListQuerySchema = z.object({
	pinned: z.coerce.boolean().optional(),
	// Excludes archived conversations by default — matches the mockup's
	// default "Chats" list, archived ones need an explicit filter to surface.
	archived: z.coerce.boolean().default(false),
	unread_only: z.coerce.boolean().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(30),
	offset: z.coerce.number().int().min(0).default(0),
})

export const messageAttachmentSchema = z.object({
	file_id: z.string().uuid(),
	name: z.string().optional(),
	mime_type: z.string().optional(),
	size_bytes: z.number().int().nonnegative().optional(),
})

export const messageMetadataSchema = z.object({
	attachments: z.array(messageAttachmentSchema).max(MESSAGE_MAX_ATTACHMENTS).optional(),
	mentions: z.array(z.string().uuid()).max(MESSAGE_MAX_MENTIONS).optional(),
})

export const postMessageSchema = z.object({
	content: z
		.string()
		.min(1, 'Message cannot be empty')
		.max(MESSAGE_MAX_LENGTH, `Message must be ${MESSAGE_MAX_LENGTH} characters or fewer.`),
	metadata: messageMetadataSchema.optional(),
	// Only honored when the caller is an agent actor and the referenced
	// session belongs to them + carries this conversation in
	// config.conversation — see conversations route for the ownership check.
	// Ignored (silently) otherwise, e.g. for human-authored messages.
	session_id: z.string().uuid().optional(),
})

export const messageQuerySchema = z.object({
	before_id: z.coerce.number().int().positive().optional(),
	after_id: z.coerce.number().int().positive().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const updateConversationParticipantStateSchema = z
	.object({
		pinned: z.boolean().optional(),
		archived: z.boolean().optional(),
		last_read_message_id: z.number().int().positive().optional(),
	})
	.refine(
		(v) =>
			v.pinned !== undefined || v.archived !== undefined || v.last_read_message_id !== undefined,
		{
			message: 'At least one of pinned, archived, or last_read_message_id must be provided',
		},
	)
