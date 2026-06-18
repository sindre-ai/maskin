import { z } from 'zod'
import { safeMetadataSchema } from './primitives'

/**
 * `objects.metadata` shape for `type='conversation'` (per T1 architecture
 * decision and T2 metadata documentation). All fields optional — the
 * conversation panel and chat surface render sensible defaults when absent.
 *
 * - `kind` — disambiguates a 1:1 actor chat vs a multi-actor room vs a future
 *   thread surface. Reserved values: `chat` (default), `room`, `thread`.
 * - `auto_join` — actor IDs auto-seated when the conversation is first
 *   surfaced (e.g. the default agent for `chat` kind). Implementation lives
 *   on the consumer; the facade just stores the list.
 */
export const conversationMetadataSchema = z.object({
	kind: z.enum(['chat', 'room', 'thread']).optional(),
	auto_join: z.array(z.string().uuid()).max(50).optional(),
})

export const createConversationSchema = z.object({
	title: z.string().min(1).max(500).optional(),
	kind: z.enum(['chat', 'room', 'thread']).optional(),
	auto_join: z.array(z.string().uuid()).max(50).optional(),
	metadata: safeMetadataSchema.optional(),
	// Extra actors to seat at conversation creation (the caller is always
	// seated via author auto-subscribe; everyone else is seated by
	// `subscribed`-source rows on the conversation object).
	participant_actor_ids: z.array(z.string().uuid()).max(50).optional(),
})

export const conversationQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})

// Chat messages are persisted as `events` rows with `action='commented'`, so
// the create body mirrors `createCommentSchema` (the canonical comment
// contract) with the looser content cap appropriate for LLM-generated text.
// We keep `mentions` and `parent_event_id` so the facade inherits mention-
// spawn and thread-reply auto-spawn through the shared appendCommentEvent
// helper.
export const createMessageSchema = z.object({
	content: z.string().min(1).max(64_000),
	mentions: z.array(z.string().uuid()).max(50).optional(),
	parent_event_id: z.number().int().positive().optional(),
	attachment_file_ids: z.array(z.string().uuid()).max(10).optional(),
	metadata: safeMetadataSchema.optional(),
})

export const messagesQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
	offset: z.coerce.number().int().min(0).default(0),
	// before_id pages backwards through history using `events.id` (bigserial).
	before_id: z.coerce.number().int().positive().optional(),
})

export const addParticipantSchema = z.object({
	actor_id: z.string().uuid(),
})

export const participantIdParamSchema = z.object({
	id: z.string().uuid(),
	actorId: z.string().uuid(),
})
