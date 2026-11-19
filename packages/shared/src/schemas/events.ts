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
	entity_id: z.string().uuid().describe('Object ID to post the comment on.'),
	content: z
		.string()
		.min(1, 'Comment cannot be empty')
		.max(
			COMMENT_MAX_LENGTH,
			`Comment must be ${COMMENT_MAX_LENGTH} characters or fewer. Split long messages into multiple comments or replies.`,
		)
		.describe(
			`${HUMAN_MESSAGE_STYLE_SHORT} Write it like a Slack message: one thought per comment, no headers, bold labels or bulleted sections. Link other objects as \`[title](link)\`, never partial UUIDs. Max ${COMMENT_MAX_LENGTH} characters. A fenced \`\`\`chart block with a JSON spec \`{ "type": "bar"|"line"|"area", "x": "<field>", "series": ["<field>", ...], "data": [{ ... }], "caption": "..." }\` renders an inline chart.`,
		),
	mentions: z
		.array(z.string().uuid())
		.max(50)
		.optional()
		.describe(
			'Actor UUIDs to @mention. A mentioned agent gets a session to read and reply on the object; a mentioned human is notified, so mention people whose input would unblock you. Take every id from a live list_actors call, never from memory: a wrong id silently mentions nobody. Unmatched ids are dropped and listed in `unresolved_mentions`; look the actor up and post a correction.',
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
		.describe(
			`File ids from create_file or list_files, shown as cards under the comment (max ${COMMENT_MAX_ATTACHMENTS}).`,
		),
	metadata: safeMetadataSchema
		.optional()
		.describe(
			'For a live task checklist pass { tasks: ["<task-uuid>", ...] }: each row shows a checkbox (checked when the task is done), a link and its driver. Options for a human to pick go in `decision`, not here.',
		),
	decision: commentDecisionSchema.optional(),
	attention: z
		.number()
		.int()
		.min(1)
		.max(5)
		.optional()
		.describe(
			'Importance for the human reading it, 1-5, ordering their For You feed. 5 = critical, blocks progress or needs an urgent decision; 4 = high, look today; 3 = normal update or question; 2 = minor note; 1 = FYI. Reserve 5 for what is business-critical. Unset sorts below any scored comment.',
		),
})
