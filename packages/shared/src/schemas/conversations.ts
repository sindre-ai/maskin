import { z } from 'zod'
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
	/** Provider name as listed by `GET /api/integrations/providers`, e.g. 'linear'. */
	provider: z.string().min(1).max(100),
})

/**
 * What kind of text a draft is, as an open identifier: `email`, `linkedin_post`,
 * `instagram_caption`, `tiktok_caption`, `slack_message`. Only `email` changes the
 * card's layout (a To line and a Subject); every other kind is plain text whose chip
 * and button come from `label` and `approve_label`, or from the identifier itself.
 * A new channel is therefore a new string, not a code change. Per-channel limits are
 * passed as `char_limit` by whoever knows them, never hard-coded here.
 */
export const draftKindSchema = z
	.string()
	.min(1)
	.max(50)
	.regex(/^[a-z][a-z0-9_]*$/)

/**
 * An agent's draft of an outbound text, surfaced into chat as an editable card.
 * Backend-owned, never accepted from a client (the POST /messages route strips
 * it, same as `question`).
 *
 * The draft itself lives on a task, not on the message: `objectId` points at it
 * and the card reads it live, so an edit made in chat, in For you or on the task
 * page is one edit, and a scrolled-back thread never shows stale text. Only what
 * the task cannot say for itself is stored here.
 */
export const messageDraftSchema = z.object({
	/** The task holding the draft: `content` is the body, `metadata.draft_*` the rest. */
	object_id: z.string().uuid(),
	kind: draftKindSchema,
	/** Recipient shown read-only on the card, e.g. "Mette Holm, Northwind". Email only. */
	to: z.string().min(1).max(300).optional(),
	/** Chip text and button text for a `text` kind, or to override a preset. */
	label: z.string().min(1).max(30).optional(),
	approve_label: z.string().min(1).max(40).optional(),
	/** The channel's hard limit in characters, e.g. 300 for a LinkedIn connection note. */
	char_limit: z.number().int().positive().max(100_000).optional(),
})

/**
 * The draft's state on the task a draft card points at. `original_*` is what the
 * agent wrote, kept so the card can say "Edited" and restore it.
 *
 * Stored as flat `draft_*` keys in the task's `metadata` (see DRAFT_METADATA_KEYS),
 * because object metadata is flat by design (`safeMetadataSchema`) and a nested
 * `metadata.draft` object would be rejected with a 400.
 */
export const draftTaskStateSchema = z.object({
	state: z.enum(['draft', 'approved']),
	subject: z.string().max(998).optional(),
	original_subject: z.string().max(998).optional(),
	original_body: z.string().max(100_000),
	approved_at: z.string().datetime().optional(),
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
	final_output: messageFinalOutputSchema.optional(),
	/** Backend-owned: an agent's AskUserQuestion, surfaced as chips in chat. */
	question: messageQuestionSchema.optional(),
	/** Client-supplied: which options the human picked for a `question`. */
	question_answer: messageQuestionAnswerSchema.optional(),
	/** Backend-owned: an agent's request to connect an integration, shown as a card. */
	integration_connect: messageIntegrationConnectSchema.optional(),
	/** Backend-owned: an agent's draft of an outbound text, shown as an editable card. */
	draft: messageDraftSchema.optional(),
	/** Backend-owned: the helper session whose result this message hands to its sender. */
	helper_return: z.string().uuid().optional(),
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
		integration_connect: _integrationConnect,
		draft: _draft,
		...rest
	} = metadata
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
	pinned: booleanQueryParam.optional(),
	// Excludes archived conversations by default — matches the mockup's
	// default "Chats" list, archived ones need an explicit filter to surface.
	archived: booleanQueryParam.default(false),
	unread_only: booleanQueryParam.optional(),
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
export type MessageFinalOutput = z.infer<typeof messageFinalOutputSchema>
export type MessageQuestion = z.infer<typeof messageQuestionSchema>
export type MessageDraft = z.infer<typeof messageDraftSchema>
export type DraftKind = z.infer<typeof draftKindSchema>
export type DraftTaskState = z.infer<typeof draftTaskStateSchema>
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
 * The `draft` request body: what `post_draft` was called with. Email needs a
 * recipient and a subject, because a card without them cannot be sent as shown.
 */
export const sessionDraftSchema = z
	.object({
		kind: draftKindSchema,
		/**
		 * Chip text on the card, e.g. "SLACK MESSAGE". The `kind` presets cover the
		 * common cases; anything else is `kind: 'text'` plus a label of your own.
		 */
		label: z.string().min(1).max(30).optional(),
		/** Text of the approve button, e.g. "Approve and send". Defaults per kind. */
		approve_label: z.string().min(1).max(40).optional(),
		/**
		 * The object type that holds a new draft. Workspaces define their own types, so
		 * this is whatever the workspace has (see get_workspace_schema); defaults to
		 * `task`. Ignored when `object_id` is given.
		 */
		object_type: z
			.string()
			.min(1)
			.max(50)
			.regex(/^[a-z][a-z0-9_]*$/)
			.optional(),
		/**
		 * Status for a new draft object. Defaults to `in_review` when the type has it,
		 * else the type's first configured status. Ignored when `object_id` is given.
		 */
		status: z.string().min(1).max(100).optional(),
		/** The new object's title; derived from the kind and recipient when absent. */
		title: z.string().min(1).max(200).optional(),
		body: z.string().min(1).max(100_000),
		to: z.string().min(1).max(300).optional(),
		subject: z.string().min(1).max(998).optional(),
		char_limit: z.number().int().positive().max(100_000).optional(),
	})
	.superRefine((draft, ctx) => {
		if (draft.kind === 'email') {
			if (!draft.to)
				ctx.addIssue({ code: 'custom', path: ['to'], message: 'An email needs a recipient' })
			if (!draft.subject) {
				ctx.addIssue({ code: 'custom', path: ['subject'], message: 'An email needs a subject' })
			}
		}
		if (draft.char_limit !== undefined && draft.body.length > draft.char_limit) {
			ctx.addIssue({
				code: 'custom',
				path: ['body'],
				message: `The draft is ${draft.body.length} characters; the limit is ${draft.char_limit}`,
			})
		}
	})

/** A readable name for a draft kind, e.g. `linkedin_post` becomes "linkedin post". */
export function draftKindName(kind: string): string {
	return kind.replace(/_/g, ' ')
}

/**
 * The plain-markdown rendering of a connect card, used as the message's
 * `content` so every reader that isn't the chat UI still says what is needed.
 */
export function formatIntegrationConnectAsMarkdown(displayName: string): string {
	return `Connect **${displayName}** to continue — use the Connect card below, or go to Settings → Integrations.`
}

/** The `ask` request body: the tool input, as the in-container hook forwards it. */
export const sessionAskSchema = z.object({
	questions: z.array(messageQuestionItemSchema).min(1).max(MESSAGE_MAX_QUESTIONS),
})

/**
 * The plain-markdown rendering of a draft, used as the message's `content` so
 * every reader that isn't the chat UI (MCP tools, notifications, search) sees
 * the text itself and not just a pointer to it.
 */
export function formatDraftAsMarkdown(draft: {
	to?: string
	subject?: string
	body: string
}): string {
	const head = [
		draft.to ? `**To:** ${draft.to}` : null,
		draft.subject ? `**Subject:** ${draft.subject}` : null,
	].filter((line): line is string => line !== null)
	const quoted = draft.body
		.split('\n')
		.map((line) => (line ? `> ${line}` : '>'))
		.join('\n')
	return [...head, quoted].join('\n\n')
}

/** The task `metadata` keys that hold a draft's state. */
export const DRAFT_METADATA_KEYS = {
	state: 'draft_state',
	subject: 'draft_subject',
	original_subject: 'draft_original_subject',
	original_body: 'draft_original_body',
	approved_at: 'draft_approved_at',
} as const

/** Reads a draft's state off a task's metadata; null when absent or malformed. */
export function readDraftTaskState(
	metadata: Record<string, unknown> | null | undefined,
): DraftTaskState | null {
	const get = (key: keyof typeof DRAFT_METADATA_KEYS) => {
		const value = metadata?.[DRAFT_METADATA_KEYS[key]]
		return value === null ? undefined : value
	}
	const parsed = draftTaskStateSchema.safeParse({
		state: get('state'),
		subject: get('subject'),
		original_subject: get('original_subject'),
		original_body: get('original_body'),
		approved_at: get('approved_at'),
	})
	return parsed.success ? parsed.data : null
}

/**
 * The flat metadata keys for a draft state, ready to spread over a task's
 * existing metadata. Absent optional fields become `null`, so a write that
 * clears one (undoing an approval) overwrites the old value instead of leaving it.
 */
export function draftTaskStateToMetadata(state: DraftTaskState): Record<string, string | null> {
	return {
		[DRAFT_METADATA_KEYS.state]: state.state,
		[DRAFT_METADATA_KEYS.subject]: state.subject ?? null,
		[DRAFT_METADATA_KEYS.original_subject]: state.original_subject ?? null,
		[DRAFT_METADATA_KEYS.original_body]: state.original_body,
		[DRAFT_METADATA_KEYS.approved_at]: state.approved_at ?? null,
	}
}

/**
 * A change to a draft's state, sent by the draft card. The server applies it to the
 * row it has locked, so the card never writes a state it merely remembers: each
 * action says which state it saw (`expected_state`) and is refused if the draft has
 * moved since. That is what stops a stale tab editing text that was already approved,
 * and a second tab approving (and so messaging the agent) a second time.
 */
export const draftTransitionSchema = z.object({
	action: z.enum(['edit', 'approve', 'undo', 'restore']),
	expected_state: z.enum(['draft', 'approved']),
	/** The text to save with `edit` / `approve`; omitted keeps what the task holds. */
	body: z.string().max(100_000).optional(),
	/** The subject to save with `edit` / `approve`; omitted keeps what the task holds. */
	subject: z.string().max(998).optional(),
})

export type DraftTransition = z.infer<typeof draftTransitionSchema>

export type DraftTransitionResult =
	| { ok: true; content: string; state: DraftTaskState }
	| { ok: false; reason: 'not_a_draft' | 'state_changed' | 'empty_body' }

/**
 * Applies a draft transition to a task's current content and metadata. Pure, so the
 * route and the tests share one definition of which actions are legal in which state:
 * only an unapproved draft can be edited, approved or restored, and only an approved
 * one can be undone.
 */
export function applyDraftTransition(
	task: { content: string | null; metadata: Record<string, unknown> | null },
	transition: DraftTransition,
	now: Date = new Date(),
): DraftTransitionResult {
	const current = readDraftTaskState(task.metadata)
	if (!current) return { ok: false, reason: 'not_a_draft' }

	const requiredState = transition.action === 'undo' ? 'approved' : 'draft'
	if (current.state !== transition.expected_state || current.state !== requiredState) {
		return { ok: false, reason: 'state_changed' }
	}

	let content = task.content ?? ''
	let subject = current.subject
	if (transition.action === 'edit' || transition.action === 'approve') {
		content = transition.body ?? content
		subject = transition.subject ?? subject
	} else if (transition.action === 'restore') {
		content = current.original_body
		subject = current.original_subject
	}

	if (transition.action === 'approve' && content.trim() === '') {
		return { ok: false, reason: 'empty_body' }
	}

	const approving = transition.action === 'approve'
	return {
		ok: true,
		content,
		state: {
			...current,
			state: approving ? 'approved' : 'draft',
			subject,
			approved_at: approving ? now.toISOString() : undefined,
		},
	}
}
