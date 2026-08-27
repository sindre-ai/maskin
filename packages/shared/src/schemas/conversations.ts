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
	/**
	 * The `result` envelope carried no text, so the reply was recovered from the
	 * turn's last `assistant` text line instead. Kept as a marker because that
	 * fallback can surface mid-turn narration rather than a deliberate reply —
	 * it makes the over-eager cases findable without hunting through logs.
	 */
	recovered: z.boolean().optional(),
	is_error: z.boolean().optional(),
	/**
	 * How a failed turn (`is_error`) was read: 'transient' means the model API
	 * blipped and the turn was replayed, 'permanent' means no replay would have
	 * helped (credentials, credit, a malformed request). See
	 * apps/dev/src/lib/turn-error-classifier.ts.
	 */
	error_kind: z.enum(['transient', 'permanent']).optional(),
	/** Replays spent before giving up on a transient failure. */
	retries: z.number().int().min(0).max(10).optional(),
	/**
	 * Why a transient failure was reported instead of replayed:
	 * 'unavailable' — the turn's opening envelope could not be recovered;
	 * 'undeliverable' — the replay could not reach the CLI (session gone);
	 * 'unanswered' — the replay was written but the turn never produced a
	 * result envelope, so the CLI is presumed wedged on stdin.
	 */
	retry: z.enum(['unavailable', 'undeliverable', 'unanswered']).optional(),
	subtype: z.string().max(64).optional(),
	/** Set when the agent's output exceeded MESSAGE_MAX_LENGTH and was cut. */
	truncated: z.boolean().optional(),
})

export const MESSAGE_MAX_QUESTIONS = 4
export const MESSAGE_MAX_QUESTION_OPTIONS = 4

/**
 * One question an agent asked the human mid-turn, mirroring the shape of the
 * Claude Code AskUserQuestion tool input so the hook that intercepts it can
 * forward the payload without reshaping it.
 */
export const messageQuestionItemSchema = z.object({
	question: z.string().min(1).max(1000),
	/** Short chip label for the question, e.g. 'Spotify access'. */
	header: z.string().min(1).max(24),
	multi_select: z.boolean().default(false),
	options: z
		.array(
			z.object({
				label: z.string().min(1).max(200),
				description: z.string().max(1000).optional(),
			}),
		)
		.min(2)
		.max(MESSAGE_MAX_QUESTION_OPTIONS),
})

/**
 * Set by the backend when an agent in a chat calls AskUserQuestion, which the
 * headless CLI cannot render on its own (see
 * docker/agent-base/hooks/ask-user-question.sh). Never accepted from a client —
 * the POST /messages route strips it, so a forged message cannot put words in
 * an agent's mouth as an official prompt.
 *
 * The message's `content` carries the same questions as plain markdown, so a
 * reader that knows nothing about this metadata (notifications, digests, the
 * MCP conversation tools) still shows something sensible.
 */
export const messageQuestionSchema = z.object({
	/** The session whose turn asked. Ties the answer back to the right agent. */
	session_id: z.string().uuid(),
	questions: z.array(messageQuestionItemSchema).min(1).max(MESSAGE_MAX_QUESTIONS),
})

/**
 * Set on the human's reply to a `question` message. Unlike `question` this IS
 * client-supplied — the frontend posts it when the human picks chips — so it
 * carries no authority beyond letting the UI pair an answer to its question.
 */
export const messageQuestionAnswerSchema = z.object({
	/** `messages.id` of the question being answered. */
	question_message_id: z.number().int().positive(),
	answers: z
		.array(
			z.object({
				header: z.string().min(1).max(24),
				selected: z.array(z.string().min(1).max(200)).min(1).max(MESSAGE_MAX_QUESTION_OPTIONS),
			}),
		)
		.min(1)
		.max(MESSAGE_MAX_QUESTIONS),
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
	/** Backend-owned: an agent's AskUserQuestion, surfaced as chips in chat. */
	question: messageQuestionSchema.optional(),
	/** Client-supplied: which options the human picked for a `question`. */
	question_answer: messageQuestionAnswerSchema.optional(),
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
	const { source: _source, final_output: _finalOutput, question: _question, ...rest } = metadata
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

export const editMessageSchema = z.object({
	content: z
		.string()
		.min(1, 'Message cannot be empty')
		.max(MESSAGE_MAX_LENGTH, `Message must be ${MESSAGE_MAX_LENGTH} characters or fewer.`),
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
export type MessageQuestion = z.infer<typeof messageQuestionSchema>
export type MessageQuestionItem = z.infer<typeof messageQuestionItemSchema>
export type MessageQuestionAnswer = z.infer<typeof messageQuestionAnswerSchema>

/**
 * The plain-markdown rendering of a question set, used as the message's
 * `content`. Everything that isn't the chip-aware chat UI reads this.
 */
export function formatQuestionsAsMarkdown(questions: MessageQuestionItem[]): string {
	return questions
		.map((q) => {
			const options = q.options.map(
				(o) => `- **${o.label}**${o.description ? ` — ${o.description}` : ''}`,
			)
			return [q.question, ...options].join('\n')
		})
		.join('\n\n')
}

/** The `ask` request body: the tool input, as the in-container hook forwards it. */
export const sessionAskSchema = z.object({
	questions: z.array(messageQuestionItemSchema).min(1).max(MESSAGE_MAX_QUESTIONS),
})
