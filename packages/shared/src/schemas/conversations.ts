import { z } from 'zod'

export const CONVERSATION_TITLE_MAX_LENGTH = 200
// Conversations are created with this placeholder and are given a real,
// content-derived title moments later by the backend auto-titler
// (apps/dev/src/services/conversation-titler.ts). It stays only when the
// workspace has no LLM credential of any kind.
export const NEW_CONVERSATION_PLACEHOLDER_TITLE = 'New chat'
// Chat turns run longer than object comments (COMMENT_MAX_LENGTH in events.ts).
export const MESSAGE_MAX_LENGTH = 8000
export const MAX_CONVERSATION_PARTICIPANTS = 50
export const MESSAGE_MAX_ATTACHMENTS = 10
export const MESSAGE_MAX_MENTIONS = 50
export const MESSAGE_MAX_CONTEXT_ITEMS = 20

export const messageAttachmentSchema = z.object({
	file_id: z.string().uuid(),
	name: z.string().optional(),
	mime_type: z.string().optional(),
	size_bytes: z.number().int().nonnegative().optional(),
})

export const messageContextObjectSchema = z.object({
	id: z.string().uuid(),
	title: z.string().max(500).optional(),
	type: z.string().max(50).optional(),
})

export const messageContextNotificationSchema = z.object({
	id: z.string().uuid(),
	title: z.string().max(500).optional(),
})

/**
 * Set by the backend on a message auto-posted from an agent's end-of-turn
 * final output (apps/dev/src/services/interactive-turn-finalizer.ts).
 * Never accepted from a client — the POST /messages route strips it.
 */
export const messageFinalOutputSchema = z.object({
	/**
	 * sha256 of the raw stream-json result line. Backs a partial unique index
	 * on messages so a Docker log replay (`tail: 'all'` on reconnect) cannot
	 * re-post turns that were already delivered.
	 */
	dedupe_key: z.string().min(1).max(64),
	/** The conversation message whose turn produced this output, if resolvable. */
	message_id: z.number().int().nullable().optional(),
	is_error: z.boolean().optional(),
	subtype: z.string().max(64).optional(),
	/** Set when the agent's output exceeded MESSAGE_MAX_LENGTH and was cut. */
	truncated: z.boolean().optional(),
})

export const messageMetadataSchema = z.object({
	attachments: z.array(messageAttachmentSchema).max(MESSAGE_MAX_ATTACHMENTS).optional(),
	mentions: z.array(z.string().uuid()).max(MESSAGE_MAX_MENTIONS).optional(),
	context_objects: z.array(messageContextObjectSchema).max(MESSAGE_MAX_CONTEXT_ITEMS).optional(),
	context_notifications: z
		.array(messageContextNotificationSchema)
		.max(MESSAGE_MAX_CONTEXT_ITEMS)
		.optional(),
	/**
	 * Marks how the message came to exist. Absent for anything a human typed
	 * or an agent posted via the post_conversation_message MCP tool;
	 * 'final_output' for an agent's automatically-posted end-of-turn reply.
	 */
	source: z.enum(['final_output']).optional(),
	final_output: messageFinalOutputSchema.optional(),
})

/**
 * Strips the backend-owned markers from client-supplied metadata so the
 * `source` discriminator stays trustworthy — the frontend reconciles its
 * optimistic bubble against it, and a client could otherwise claim it.
 */
export function stripServerOwnedMetadata<T extends Record<string, unknown> | undefined>(
	metadata: T,
): T {
	if (!metadata) return metadata
	const { source: _source, final_output: _finalOutput, ...rest } = metadata
	return rest as T
}

export const createConversationSchema = z.object({
	title: z.string().min(1, 'Title cannot be empty').max(CONVERSATION_TITLE_MAX_LENGTH),
	participant_actor_ids: z.array(z.string().uuid()).max(MAX_CONVERSATION_PARTICIPANTS),
	initial_message: z.string().min(1).max(MESSAGE_MAX_LENGTH).optional(),
	// Structured context (objects/notifications picked via the composer) for the
	// initial message — mirrors postMessageSchema's metadata so a brand-new
	// conversation's first turn renders context as chips instead of inline text.
	initial_message_metadata: messageMetadataSchema.optional(),
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

export type MessageMetadata = z.infer<typeof messageMetadataSchema>
export type MessageFinalOutput = z.infer<typeof messageFinalOutputSchema>
