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

// "Edit + restart agent" body — the resend route is allowed to optionally edit
// the original comment's content in the same call so the agent re-runs against
// the corrected message in one round-trip. Content is optional so a plain
// "restart from the same message" works too.
export const resendCommentSchema = z.object({
	content: z
		.string()
		.min(1, 'Comment cannot be empty')
		.max(
			COMMENT_MAX_LENGTH,
			`Comment must be ${COMMENT_MAX_LENGTH} characters or fewer. Split long messages into multiple comments or replies.`,
		)
		.optional(),
})
