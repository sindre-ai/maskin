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
export const COMMENT_MAX_REFS = 6

/**
 * A typed reference rendered as a chip under a comment — the agent pointing at
 * something concrete it wrote, or at a part of the product it is explaining.
 *
 * Lives as a first-class field on the comment rather than inside `metadata`
 * because `safeMetadataSchema` only admits primitives and arrays of
 * primitives, and a ref is an object.
 */
export const commentRefSchema = z
	.object({
		kind: z
			.enum(['object', 'page'])
			.describe(
				'`object` links to something in this workspace; `page` links to a product surface.',
			),
		tag: z
			.string()
			.min(1)
			.max(12)
			.describe('Short uppercase type marker shown on the chip, e.g. KNOWLEDGE, BET, LOOP, PAGE.'),
		label: z
			.string()
			.min(1)
			.max(80)
			.describe('Chip text — the title of the thing being referenced.'),
		object_id: z
			.string()
			.uuid()
			.optional()
			.describe('Required for kind `object` — the object this chip opens.'),
		path: z
			.string()
			.max(120)
			.regex(/^[a-z0-9\-/]*$/, 'Path must be a workspace-relative route segment')
			.optional()
			.describe('Required for kind `page` — workspace-relative route, e.g. `chats` or `loops`.'),
		detail: z
			.string()
			.max(600)
			.optional()
			.describe('Optional sentence revealed inline when the reader expands the chip.'),
	})
	.refine((ref) => (ref.kind === 'object' ? Boolean(ref.object_id) : Boolean(ref.path)), {
		message: 'kind "object" requires object_id; kind "page" requires path',
	})

export type CommentRef = z.infer<typeof commentRefSchema>

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
			`Write it like a Slack message, not a report: one thought per comment, plain conversational language, direct. No headers, no bold labels, no bulleted sections, no walls of text. When referencing another object in human-facing text, use a markdown link \`[title](link)\` — never paste partial UUIDs. Hard limit: ${COMMENT_MAX_LENGTH} characters — the API rejects anything over the limit with a validation error. You can embed an inline chart by writing a fenced \`\`\`chart block whose body is a JSON spec — \`{ "type": "bar" | "line" | "area", "x": "<x-field>", "series": ["<series1>", ...], "data": [{ "<x-field>": ..., "<series1>": <number>, ... }], "caption": "optional short label" }\`. The UI renders it as a bounded-height recharts visual; malformed specs degrade to a small "couldn't render chart" note without breaking the comment.`,
		),
	mentions: z
		.array(z.string().uuid())
		.max(50)
		.optional()
		.describe(
			"Array of actor UUIDs. For each @mentioned agent actor, the server creates a needs_input notification AND spawns a session that lets the agent read the comment and reply on the same object. @mention human actors whenever you need their input, decision, or attention: they get a notification about the comment, so this is the right way to pull a human into the loop. Don't mention humans gratuitously, but don't hesitate to mention them when their input would actually unblock you.",
		),
	parent_event_id: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Set this to thread a reply under an existing comment (use the id returned by get_comments). If a thought is long, split it into multiple short comments or use parent_event_id to thread a reply instead of one long comment.',
		),
	attachment_file_ids: z
		.array(z.string().uuid())
		.max(COMMENT_MAX_ATTACHMENTS)
		.optional()
		.describe(
			`First upload files with create_file (or pick existing ones with list_files) and pass the returned file ids here (max ${COMMENT_MAX_ATTACHMENTS}). Attached files appear as clickable cards under the posted comment.`,
		),
	refs: z
		.array(commentRefSchema)
		.max(COMMENT_MAX_REFS)
		.optional()
		.describe(
			`Up to ${COMMENT_MAX_REFS} typed reference chips rendered under the comment. Use these instead of pasting ids when you want the reader to be able to open what you are talking about — one chip per object you wrote or product surface you are explaining.`,
		),
	metadata: safeMetadataSchema
		.optional()
		.describe(
			'To prompt the human for a structured decision, pass { chips: ["Option A", "Option B", "Skip"] } — up to 5 string options, each up to 20 characters. The UI renders them as quick-reply buttons the human can tap, with a free-text fallback. Their reply is threaded under this comment. To surface a live task checklist, pass { tasks: ["<task-uuid>", ...] } — each row renders as a checkbox (checked iff the task\'s status is done/completed/succeeded), a link to the task, and its driver avatar, and updates automatically when the referenced task changes.',
		),
	attention: z
		.number()
		.int()
		.min(1)
		.max(5)
		.optional()
		.describe(
			"How important and urgent this comment is for the human reading it, on a 1-5 scale. Score it yourself, from the human's point of view — this drives the ordering of their For You feed, so score consistently rather than defaulting to the middle every time:\n" +
				'5 = Critical — blocks progress right now or needs an urgent human decision (e.g. something is broken, a deadline/money is at risk, an approval is blocking work).\n' +
				"4 = High — an important decision or blocker coming up that the human should look at today, but it isn't on fire.\n" +
				'3 = Normal — a noteworthy update, finding, or question; worth a look when convenient, no rush.\n' +
				'2 = Low — a minor note, context, or non-blocking observation.\n' +
				'1 = FYI — nice to know, purely informational, no action expected.\n' +
				"Leave unset if you genuinely can't judge urgency; an unset score sorts below any scored comment. Reserve 5 for things that are genuinely business-critical — inflating scores buries the comments that actually need it.",
		),
})
