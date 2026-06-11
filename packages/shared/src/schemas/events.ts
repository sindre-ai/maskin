import { z } from 'zod'
import { safeMetadataSchema } from './primitives'

export const eventQuerySchema = z.object({
	id: z.coerce.number().int().positive().optional(),
	entity_type: z.string().optional(),
	entity_id: z.string().uuid().optional(),
	action: z.string().optional(),
	since: z.coerce.number().optional(),
	after: z.string().datetime({ offset: true }).optional(),
	before: z.string().datetime({ offset: true }).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})

export const COMMENT_MAX_LENGTH = 2000
export const COMMENT_MAX_ATTACHMENTS = 10

export const createCommentSchema = z.object({
	entity_id: z.string().uuid(),
	content: z
		.string()
		.min(1, 'Comment cannot be empty')
		.max(
			COMMENT_MAX_LENGTH,
			`Comment must be ${COMMENT_MAX_LENGTH} characters or fewer. Split long messages into multiple comments or replies.`,
		),
	mentions: z.array(z.string().uuid()).max(50).optional(),
	parent_event_id: z.number().int().positive().optional(),
	attachment_file_ids: z.array(z.string().uuid()).max(COMMENT_MAX_ATTACHMENTS).optional(),
	metadata: safeMetadataSchema.optional(),
})

// Passive edit of an existing comment. Only `content` changes on the original
// event row; mentions, attachments, and threading stay frozen so an edit can
// never re-fire an agent (the dominant failure mode the bet is guarding
// against). The "Save & restart agent" path is a separate route (T3's resend).
export const editCommentSchema = z.object({
	content: z
		.string()
		.min(1, 'Comment cannot be empty')
		.max(
			COMMENT_MAX_LENGTH,
			`Comment must be ${COMMENT_MAX_LENGTH} characters or fewer. Split long messages into multiple comments or replies.`,
		),
})
