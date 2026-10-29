import { z } from 'zod'
import { firstStepSchema } from './first-steps'
import { booleanQueryParam } from './primitives'

export const CONVERSATION_TITLE_MAX_LENGTH = 200
// Chat turns are capped separately from object comments (COMMENT_MAX_LENGTH in events.ts).
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
	/**
	 * Copied in from a background run when it was opened as a chat, not posted live. Its
	 * thinking and tool calls are read back from that run's own log (`messages.session_id`).
	 */
	backfilled: z.boolean().optional(),
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
	/**
	 * Set when the turn ended by writing its tool calls out as text rather than
	 * making them (apps/dev/src/lib/pseudo-tool-call.ts). A separate axis from
	 * `error_kind`, which says whether a replay could have helped: without this
	 * marker these notices are indistinguishable from model-API failures, and
	 * anything querying for those over-counts.
	 */
	pseudo_tool_calls: z
		.object({
			occurrences: z.number().int().min(0),
			tags: z.array(z.string().max(64)).max(20),
			nudges: z.number().int().min(0).max(10),
		})
		.optional(),
	/**
	 * Set when the turn ended because the model returned an empty completion
	 * (no reply, no tool call) and retrying did not produce one. A separate axis
	 * from `error_kind` and `pseudo_tool_calls`: nothing was wrong with the API
	 * call and nothing was written as text, the model simply said nothing.
	 * `attempts` counts the extra asks after the CLI's own nudge; `model` is the
	 * one the session runs on and `fallback_model` the one tried last, if any.
	 */
	empty_completion: z
		.object({
			attempts: z.number().int().min(0).max(10),
			model: z.string().max(128).nullable(),
			fallback_model: z.string().max(128).optional(),
		})
		.optional(),
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
	/**
	 * The asking session is a helper another agent started, not a participant of
	 * this chat: the answer goes to that session's input, not to the chat's agents.
	 */
	reply_to_session: z.boolean().optional(),
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

/**
 * Set on a card a helper put in the chat it was started from. The helper is not in that
 * chat, so the answer goes to its session, not to the chat's agents.
 */
// A function, not a shared schema: one instance reused in several places is emitted as a $ref in
// the JSON schema of a tool that embeds the metadata (post_conversation_message), which tool
// schemas must not contain (tool-schemas-no-ref.test.ts).
const replyToSessionSchema = () => z.boolean().optional()

/**
 * Set by the backend when an agent in a chat calls `connect_integration`: the
 * chat renders a Connect card (button for OAuth providers, key input for
 * API-key providers) instead of the agent pasting a URL. Never accepted from a
 * client — the POST /messages route strips it, same as `question`.
 *
 * Only the provider name is stored. The card reads live integration status, so
 * it flips to "Connected" by itself and never shows a stale state on scrollback.
 */
export const messageIntegrationConnectSchema = z.object({
	/** The session whose turn asked. Ties the card back to the right agent. */
	session_id: z.string().uuid(),
	reply_to_session: replyToSessionSchema(),
	/** Provider name as listed by `GET /api/integrations/providers`, e.g. 'linear'. */
	provider: z.string().min(1).max(100),
})

/**
 * Backend-owned marker for a message the server put in a chat on its own
 * (nobody typed it). One object, no closed enum and no discriminated union, so
 * a new kind never needs a schema change. kind is a plain string; the proactive
 * capability note uses kind 'proactive' with a reason and a dedupe_key.
 */
export const messageDeliverySchema = z.object({
	kind: z.string().min(1).max(40),
	version: z.number().int().positive().optional(),
	reason: z.string().min(1).max(80).optional(),
	dedupe_key: z.string().min(1).max(200).optional(),
	object_id: z.string().uuid().optional(),
	comment_event_id: z.number().int().positive().optional(),
})

/**
 * One first-step button in an agent intro. The same shape and rules as the
 * creator's first_steps on create (firstStepSchema), so what is stored is held to
 * the rule it was accepted under: a send step's prompt equals its label.
 */
export const suggestedStepSchema = firstStepSchema
export const suggestedStepsSchema = z.array(suggestedStepSchema).min(1).max(4)

/** A tool the job needs: the provider name only. Status is read live, never stored. */
export const neededToolSchema = z.object({ provider: z.string().min(1).max(100) })
export const neededToolsSchema = z.array(neededToolSchema).min(1).max(3)

/**
 * Set on the person's message when it came from tapping a send step. Client-
 * supplied, so it carries no authority; it only lets tap-to-start be counted
 * from saved messages.
 */
export const fromSuggestedStepSchema = z.object({
	/** messages.id of the intro the step was on. */
	intro_message_id: z.number().int(),
	index: z.number().int().min(0).max(3),
})

/** What an agent can ask the human to put into the Keychain from a chat card. */
export const KEYCHAIN_REQUEST_KINDS = ['api_key', 'login'] as const
export type KeychainRequestKind = (typeof KEYCHAIN_REQUEST_KINDS)[number]

/**
 * An agent's request for a credential, shown as a Keychain card in the chat instead of
 * the agent asking for it in plain text. Never accepted from a client. Holds no secret
 * and never can: the human types the value into the card, which sends it straight to
 * the vault, so it never passes through the agent or this message.
 */
export const messageKeychainRequestSchema = z.object({
	/** The session whose turn asked. Ties the card back to the right agent. */
	session_id: z.string().uuid(),
	reply_to_session: replyToSessionSchema(),
	kind: z.enum(KEYCHAIN_REQUEST_KINDS),
	/** A name for the credential the card pre-fills, e.g. "e-conomic". */
	suggested_name: z.string().min(1).max(80).optional(),
	/** One line on what the credential is for, shown on the card. */
	hint: z.string().min(1).max(300).optional(),
})

/**
 * An agent's request to use a credential that already exists in the Keychain, shown as a
 * card with Allow / Not now. Never accepted from a client. Holds no secret: the card only
 * names the credential, and allowing it grants the agent access on the server.
 */
export const messageKeychainAccessRequestSchema = z.object({
	/** The session whose turn asked. Ties the card back to the right agent. */
	session_id: z.string().uuid(),
	reply_to_session: replyToSessionSchema(),
	/** The credential being asked for. */
	integration_id: z.string().uuid(),
	/** Its name as the person knows it, e.g. "Stripe". */
	credential_name: z.string().min(1).max(80),
	kind: z.enum(KEYCHAIN_REQUEST_KINDS),
	/** One line on what the agent needs it for. */
	hint: z.string().min(1).max(300).optional(),
})

/** The levels an agent can ask for on an integration that is already connected. */
export const INTEGRATION_ACCESS_REQUEST_LEVELS = ['read', 'read_write'] as const
export type IntegrationAccessRequestLevel = (typeof INTEGRATION_ACCESS_REQUEST_LEVELS)[number]

/**
 * An agent's request for more access to an integration that is connected but not allowed for
 * it, shown as a card with Allow / Not now. Never accepted from a client. The card only names
 * the integration and the level the agent asked for: allowing it is the person's own call to
 * the server, which sets the same per-agent access as Settings → Integrations.
 */
export const messageIntegrationAccessRequestSchema = z.object({
	/** The session whose turn asked. Ties the card back to the right agent. */
	session_id: z.string().uuid(),
	reply_to_session: replyToSessionSchema(),
	/** The connected integration being asked for. */
	integration_id: z.string().uuid(),
	/** Its provider name, e.g. 'slack'. */
	provider: z.string().min(1).max(100),
	/** The name the person knows it by, e.g. "Slack". */
	display_name: z.string().min(1).max(100),
	level: z.enum(INTEGRATION_ACCESS_REQUEST_LEVELS),
	/** One line on what the agent needs it for. */
	reason: z.string().min(1).max(300).optional(),
})

/**
 * The tool server an agent wants to add, as the card shows it. Functions, not shared schemas,
 * so a tool that embeds the metadata never gets a $ref (see replyToSessionSchema).
 */
const mcpServerNameSchema = () => z.string().min(1).max(60)
const mcpServerValuesSchema = () => z.record(z.string().max(100), z.string().max(4096))
const mcpServerSecretNamesSchema = () => z.array(z.string().min(1).max(100)).max(20)

/**
 * An agent's request to add a tool (MCP) server, shown as a card with Add / Not now. Never
 * accepted from a client. Holds no secret and never can: env and header values here are the
 * ones the agent may know (a region, a Keychain reference), and the secrets the server needs
 * are only named (secret_env, secret_headers). The person types those into the card, which
 * sends them straight to the server definition, so they never pass through the agent or this
 * message. Adding it is the person's own call to POST /api/custom-mcp-servers.
 */
export const messageMcpServerRequestSchema = z.object({
	/** The session whose turn asked. Ties the card back to the agent the server is given to. */
	session_id: z.string().uuid(),
	reply_to_session: replyToSessionSchema(),
	/** The name the person sees, e.g. "Linear". Editable on the card. */
	name: mcpServerNameSchema(),
	/** One line on what the agent needs it for. */
	hint: z.string().min(1).max(300).optional(),
	type: z.enum(['stdio', 'http']).optional(),
	command: z.string().min(1).max(512).optional(),
	args: z.array(z.string().max(2048)).max(100).optional(),
	url: z.string().min(1).max(2048).optional(),
	env: mcpServerValuesSchema().optional(),
	headers: mcpServerValuesSchema().optional(),
	/** Env var names the person must fill in, e.g. ["LINEAR_API_KEY"]. */
	secret_env: mcpServerSecretNamesSchema().optional(),
	/** Header names the person must fill in, e.g. ["Authorization"]. */
	secret_headers: mcpServerSecretNamesSchema().optional(),
})

/**
 * An agent's request for the person to act on the agent's own computer, shown as a card
 * in the chat. Never accepted from a client. Holds nothing sensitive: it only says what
 * the person should do. The card opens the live view of the asking agent's computer
 * (whose computer is the message's author, so it is not stored here and cannot be
 * pointed at another agent's), and its Done button hands control back by posting a
 * message.
 */
export const messageComputerRequestSchema = z.object({
	/** The session whose turn asked. Ties the card back to the right agent. */
	session_id: z.string().uuid(),
	reply_to_session: replyToSessionSchema(),
	/** What the person should do on the computer, in the agent's words. */
	task: z.string().min(1).max(500),
})

/** Which card a message answers, and how: a Not now or a Done. */
export const messageCardAnswerSchema = z.object({
	message_id: z.number().int().positive(),
	outcome: z.enum(['declined', 'done']),
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
	 * 'final_output' for an agent's automatically-posted end-of-turn reply;
	 * 'voice' for a transcript line written by the voice tool-proxy.
	 */
	source: z.enum(['final_output', 'voice']).optional(),
	/** Backend-owned: the voice_sessions row a 'voice' message was transcribed from. */
	voice_session_id: z.string().uuid().optional(),
	/**
	 * Backend-owned: what a 'voice' message is when it is not a spoken transcript line. 'show' is
	 * a draft, object or link the agent put on screen (show_in_chat); 'receipt' and
	 * 'receipt_summary' record what a call did. A spoken line has no kind.
	 */
	kind: z.string().max(40).optional(),
	final_output: messageFinalOutputSchema.optional(),
	/** Backend-owned: an agent's AskUserQuestion, surfaced as chips in chat. */
	question: messageQuestionSchema.optional(),
	/** Client-supplied: which options the human picked for a `question`. */
	question_answer: messageQuestionAnswerSchema.optional(),
	/** Backend-owned: an agent's request to connect an integration, shown as a card. */
	integration_connect: messageIntegrationConnectSchema.optional(),
	/** Backend-owned: an agent's request for a credential, shown as a Keychain card. */
	keychain_request: messageKeychainRequestSchema.optional(),
	/** Backend-owned: an agent's request to use an existing credential, shown as a card. */
	keychain_access_request: messageKeychainAccessRequestSchema.optional(),
	/** Backend-owned: an agent's request for more access to a connected integration, shown as a card. */
	integration_access_request: messageIntegrationAccessRequestSchema.optional(),
	/** Backend-owned: an agent's request to add a tool (MCP) server, shown as a card. */
	mcp_server_request: messageMcpServerRequestSchema.optional(),
	/** Backend-owned: an agent asking the person to act on its computer, shown as a card. */
	computer_request: messageComputerRequestSchema.optional(),
	/**
	 * Client-supplied: this message is the person's answer to a card (a message id), so the
	 * card reads as answered whenever the chat is opened again.
	 */
	card_answer: messageCardAnswerSchema.optional(),
	/** Backend-owned: the helper session whose result this message hands to its sender. */
	helper_return: z.string().uuid().optional(),
	/**
	 * Client-supplied: the message is a nudge for the agent (a card's Done or Allow), not
	 * something the person wrote. The agent receives it as usual; the chat does not draw it.
	 */
	hidden_from_chat: z.literal(true).optional(),
	/** Backend-owned: how the server itself put this message in the chat. */
	delivery: messageDeliverySchema.optional(),
	/** Backend-owned: the intro's first-step buttons, written once with the intro. */
	suggested_steps: suggestedStepsSchema.optional(),
	/** Backend-owned: the providers the intro's job needs, in the creator's order. */
	needed_tools: neededToolsSchema.optional(),
	/** Backend-owned: how many trailing paragraphs of the intro body the web drops when it draws the buttons and rows. */
	plain_tail: z.number().int().min(0).max(10).optional(),
	/** Client-supplied: the intro step a message was sent from. */
	from_suggested_step: fromSuggestedStepSchema.optional(),
	/** Backend-owned: the `commented` event this message was copied from (object chats). */
	comment_event_id: z.number().int().optional(),
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
	const {
		source: _source,
		final_output: _finalOutput,
		question: _question,
		voice_session_id: _voiceSessionId,
		kind: _kind,
		integration_connect: _integrationConnect,
		helper_return: _helperReturn,
		delivery: _delivery,
		suggested_steps: _suggestedSteps,
		needed_tools: _neededTools,
		plain_tail: _plainTail,
		keychain_request: _keychainRequest,
		keychain_access_request: _keychainAccessRequest,
		integration_access_request: _integrationAccessRequest,
		mcp_server_request: _mcpServerRequest,
		computer_request: _computerRequest,
		comment_event_id: _commentEventId,
		...rest
	} = metadata
	return rest as T
}

/** What a group chat is about: an object (task, bet, insight) or an installed loop. */
export const conversationSubjectSchema = z.object({
	type: z.enum(['object', 'loop']),
	id: z.string().uuid(),
})

export const createConversationSchema = z.object({
	// With a subject, asking again returns the chat that already exists for it
	// (and adds any new participants) instead of creating a second one.
	subject: conversationSubjectSchema.optional(),
	title: z.string().min(1, 'Title cannot be empty').max(CONVERSATION_TITLE_MAX_LENGTH),
	participant_actor_ids: z.array(z.string().uuid()).max(MAX_CONVERSATION_PARTICIPANTS),
	// Open the direct message (DM) with the one other participant instead of a new
	// topical chat: the pair's existing DM is returned (200), or created once (201,
	// titled with `title`). Leave it out for a new topical chat, which is always created.
	direct: z.boolean().optional(),
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
	pinned: booleanQueryParam.optional(),
	// Excludes archived conversations by default — matches the mockup's
	// default "Chats" list, archived ones need an explicit filter to surface.
	archived: booleanQueryParam.default(false),
	unread_only: booleanQueryParam.optional(),
	subject_type: z.enum(['object', 'loop']).optional(),
	subject_id: z.string().uuid().optional(),
	// Only chats with a message after this time (ISO 8601).
	updated_after: z.string().datetime({ offset: true }).optional(),
	// Only chats that still have at least one human participant.
	has_human: booleanQueryParam.optional(),
	// 'pinned' (default) keeps pinned chats on top, as the chat list shows them;
	// 'activity' orders purely by last message, newest first.
	sort: z.enum(['pinned', 'activity']).default('pinned'),
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
	// Post as a reply in the thread rooted at this message. The root must be a
	// top-level message of the same conversation (threads do not nest).
	thread_root_id: z.number().int().positive().optional(),
	// With thread_root_id: also show the reply in the main timeline.
	also_in_channel: z.boolean().optional(),
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
	// Return only the replies of this thread (newest-first like the main list).
	thread_root_id: z.coerce.number().int().positive().optional(),
})

export const threadListQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(30),
})

export const markThreadReadSchema = z.object({
	last_read_message_id: z.number().int().positive(),
})

export const updateConversationParticipantStateSchema = z
	.object({
		pinned: z.boolean().optional(),
		archived: z.boolean().optional(),
		// Advance-only read cursor. The route wraps this in GREATEST() so read
		// state never regresses; a *reset* is `mark_unread` below, not a lower id.
		last_read_message_id: z.number().int().positive().optional(),
		/**
		 * Reset the caller's read cursor to "nothing read yet". Writes null
		 * directly rather than a sentinel id, because null is already the one
		 * value the read queries COALESCE to 0 and a fresh participant row starts
		 * at — so 0 never has to travel on the wire, and last_read_message_id
		 * stays positive-only.
		 */
		mark_unread: z.boolean().optional(),
	})
	.refine(
		(v) =>
			v.pinned !== undefined ||
			v.archived !== undefined ||
			v.last_read_message_id !== undefined ||
			v.mark_unread !== undefined,
		{
			message:
				'At least one of pinned, archived, last_read_message_id, or mark_unread must be provided',
		},
	)
	.refine((v) => !(v.mark_unread === true && v.last_read_message_id !== undefined), {
		message: 'mark_unread and last_read_message_id cannot be provided together',
	})

export type MessageMetadata = z.infer<typeof messageMetadataSchema>
export type MessageDelivery = z.infer<typeof messageDeliverySchema>
export type SuggestedStep = z.infer<typeof suggestedStepSchema>
export type NeededTool = z.infer<typeof neededToolSchema>
export type FromSuggestedStep = z.infer<typeof fromSuggestedStepSchema>
export type MessageFinalOutput = z.infer<typeof messageFinalOutputSchema>
export type MessageQuestion = z.infer<typeof messageQuestionSchema>
export type MessageIntegrationConnect = z.infer<typeof messageIntegrationConnectSchema>
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

/** The `connect-card` request body: the provider `connect_integration` was called with. */
export const sessionConnectCardSchema = z.object({
	provider: z.string().min(1).max(100),
})

/**
 * The plain-markdown rendering of a connect card, used as the message's
 * `content` so every reader that isn't the chat UI still says what is needed.
 */
export function formatIntegrationConnectAsMarkdown(displayName: string): string {
	return `Connect **${displayName}** to continue — use the Connect card below, or go to Settings → Integrations.`
}

/** The `keychain-card` request body: the tool input, minus the session the server knows. */
export const sessionKeychainCardSchema = z.object({
	kind: z.enum(KEYCHAIN_REQUEST_KINDS),
	suggested_name: z.string().trim().min(1).max(80).optional(),
	hint: z.string().trim().min(1).max(300).optional(),
})

/**
 * The plain-markdown rendering of a keychain card, used as the message's `content` so
 * every reader that isn't the chat UI still says what is needed.
 */
export function formatKeychainRequestAsMarkdown(
	kind: KeychainRequestKind,
	suggestedName?: string,
	hint?: string,
): string {
	const what = kind === 'login' ? 'a login (username and password)' : 'an API key'
	const named = suggestedName ? ` for **${suggestedName}**` : ''
	const why = hint ? ` ${hint}` : ''
	return `I need ${what}${named}.${why} Add it with the Keychain card below, or in Settings → Keychain. It goes straight to your vault, so I never see it.`
}

/** The `keychain-access-card` request body: the tool input, minus the session the server knows. */
export const sessionKeychainAccessCardSchema = z.object({
	/** The credential's name, as listed by `list_keychain_credentials`. */
	credential_name: z.string().trim().min(1).max(80),
	hint: z.string().trim().min(1).max(300).optional(),
})

/** The plain-markdown rendering of an access card, for every reader that isn't the chat UI. */
export function formatKeychainAccessRequestAsMarkdown(
	credentialName: string,
	hint?: string,
): string {
	const why = hint ? ` ${hint}` : ''
	return `I'd like to use **${credentialName}** from your Keychain.${why} Allow it with the card below, or in Settings → Keychain. I never see the secret itself.`
}

/** The `integration-access-card` request body: the tool input, minus the session the server knows. */
export const sessionIntegrationAccessCardSchema = z.object({
	integration_id: z.string().uuid(),
	level: z.enum(INTEGRATION_ACCESS_REQUEST_LEVELS),
	reason: z.string().trim().min(1).max(300).optional(),
})

/** The plain-markdown rendering of an integration access card, for every reader that isn't the chat UI. */
export function formatIntegrationAccessRequestAsMarkdown(
	displayName: string,
	level: IntegrationAccessRequestLevel,
	reason?: string,
): string {
	const what = level === 'read_write' ? 'read and write access' : 'read access'
	const why = reason ? ` ${reason}` : ''
	return `I'd like ${what} to **${displayName}**.${why} Allow it with the card below, or in Settings → Integrations.`
}

/** The `mcp-server-card` request body: the tool input, minus the session the server knows. */
export const sessionMcpServerCardSchema = z.object({
	name: z.string().trim().min(1).max(60),
	hint: z.string().trim().min(1).max(300).optional(),
	type: z.enum(['stdio', 'http']).optional(),
	command: z.string().trim().min(1).max(512).optional(),
	args: z.array(z.string().max(2048)).max(100).optional(),
	url: z.string().trim().min(1).max(2048).optional(),
	env: z.record(z.string().max(100), z.string().max(4096)).optional(),
	headers: z.record(z.string().max(100), z.string().max(4096)).optional(),
	secret_env: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
	secret_headers: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
})

/** The plain-markdown rendering of an add-server card, for every reader that isn't the chat UI. */
export function formatMcpServerRequestAsMarkdown(name: string, hint?: string): string {
	const why = hint ? ` ${hint}` : ''
	return `I'd like to add the **${name}** tool server.${why} Add it with the card below, or in Settings → Integrations. Any key it needs goes straight into the server, so I never see it.`
}

/** The `computer-card` request body: the tool input, minus the session the server knows. */
export const sessionComputerCardSchema = z.object({
	/** What the person should do, e.g. "Log in to e-conomic and approve the 2FA prompt." */
	task: z.string().trim().min(1).max(500),
})

/** The plain-markdown rendering of a computer card, for every reader that isn't the chat UI. */
export function formatComputerRequestAsMarkdown(task: string): string {
	return `I need you to do something on my computer: ${task}\n\nOpen it with the card below. Press Done there when you have finished, and I will carry on.`
}

/** The `ask` request body: the tool input, as the in-container hook forwards it. */
export const sessionAskSchema = z.object({
	questions: z.array(messageQuestionItemSchema).min(1).max(MESSAGE_MAX_QUESTIONS),
})

export const MESSAGE_REACTION_MAX_LENGTH = 16

/** One emoji (possibly several code points: skin tones, ZWJ sequences, variation selectors). */
export const reactionEmojiSchema = z
	.string()
	.min(1)
	.max(MESSAGE_REACTION_MAX_LENGTH)
	.refine((v) => /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3/u.test(v), {
		message: 'Must be an emoji',
	})

export const addReactionSchema = z.object({ emoji: reactionEmojiSchema })

export const removeReactionQuerySchema = z.object({ emoji: reactionEmojiSchema })
