import { z } from 'zod'
import { HUMAN_MESSAGE_STYLE_SHORT } from '../prompts'
import { commentDecisionSchema } from './comment-decision'
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

export const COMMENT_MAX_LENGTH = 50000
export const COMMENT_MAX_ATTACHMENTS = 10

export const createCommentSchema = z.object({
	entity_id: z.string().uuid(),
	content: z
		.string()
		.min(1, 'Comment cannot be empty')
		.max(
			COMMENT_MAX_LENGTH,
			`Comment must be ${COMMENT_MAX_LENGTH} characters or fewer. Split long messages into multiple comments or replies.`,
		)
		.describe(
			`${HUMAN_MESSAGE_STYLE_SHORT} Write it like a Slack message: one thought per comment, no headers, bold labels or bulleted sections. Link other objects as \`[title](link)\`, never partial UUIDs. A fenced \`\`\`chart block holding JSON { type: bar|line|area, x, series, data, caption } renders an inline chart.`,
		),
	mentions: z
		.array(z.string().uuid())
		.max(50)
		.optional()
		.describe(
			'Actor UUIDs to @mention, from a live list_actors call and never from memory (a wrong id silently mentions nobody). A mentioned agent gets a session to reply; a human is notified. Unmatched ids are dropped and listed in `unresolved_mentions`.',
		),
	parent_event_id: z
		.number()
		.int()
		.positive()
		.optional()
		.describe('Thread a reply under an existing comment (an id from get_comments).'),
	attachment_file_ids: z
		.array(z.string().uuid())
		.max(COMMENT_MAX_ATTACHMENTS)
		.optional()
		.describe('File ids (create_file, list_files), shown as cards.'),
	metadata: safeMetadataSchema
		.optional()
		.describe(
			'For a live task checklist pass { tasks: ["<task-uuid>", ...] }. Options for a human to pick go in `decision`, not here.',
		),
	decision: commentDecisionSchema.optional(),
	attention: z
		.number()
		.int()
		.min(1)
		.max(5)
		.optional()
		.describe(
			'Importance for the human, 1-5, ordering their For You feed: 5 critical (urgent decision or blocks work), 4 look today, 3 normal, 2 minor, 1 FYI.',
		),
})

// Editing a comment changes what it says and nothing else: mentions, attachments and the
// parent stay as they were, so an edit never wakes anyone.
export const updateCommentSchema = z.object({
	content: z
		.string()
		.min(1, 'Comment cannot be empty')
		.max(COMMENT_MAX_LENGTH, `Comment must be ${COMMENT_MAX_LENGTH} characters or fewer.`),
})
