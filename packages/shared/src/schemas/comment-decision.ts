import { z } from 'zod'

/**
 * The structured decision block an agent attaches to a comment when it needs a
 * human to make a call.
 *
 * The `.describe()` strings below are not internal notes — they are the
 * agent-facing specification. `create_comment.inputSchema` spreads
 * `createCommentSchema.shape` (packages/mcp/src/tools.ts) and the MCP SDK turns
 * every description into the JSON Schema `description` of that property, so
 * this is the text an agent reads at the moment it composes the call. Keep each
 * rule on the field it governs, and edit them as documentation rather than as
 * comments.
 */

const TITLE_MIN_WORDS = 3
const TITLE_MAX_WORDS = 7
const OPTION_LABEL_MAX_WORDS = 4
const SUMMARY_MAX_SENTENCES = 2

export const DRAFTS_MAX = 10
export const OPTIONS_MIN = 2
export const OPTIONS_MAX = 3
export const CONSEQUENCES_MIN = 2
export const CONSEQUENCES_MAX = 3

// Words that stand in for a number the agent should have looked up. The point
// of the summary is one real figure, so these are the tell that it is missing.
const HEDGE_WORDS = [
	'significantly',
	'substantially',
	'meaningfully',
	'considerably',
	'somewhat',
	'relatively',
	'fairly',
	'quite',
	'several',
	'many',
]

// Dropped before comparing the title against the summary, so "Is the onboarding
// bet worth running?" against "The onboarding bet is worth running." reads as a
// restatement rather than as two different sentences.
const STOPWORDS = new Set([
	'a',
	'an',
	'and',
	'are',
	'as',
	'at',
	'be',
	'but',
	'by',
	'do',
	'for',
	'from',
	'has',
	'have',
	'in',
	'is',
	'it',
	'of',
	'on',
	'or',
	'the',
	'this',
	'to',
	'was',
	'we',
	'with',
])

export const decisionOptionSchema = z.object({
	label: z
		.string()
		.min(1)
		.describe(
			`${OPTION_LABEL_MAX_WORDS} words or fewer, sentence case. The choice itself: "7-day window", "Hold", "Ship to 10%". Not a sentence, and not a verb phrase describing what you will do.`,
		),
	consequences: z
		.array(z.string().min(1))
		.min(CONSEQUENCES_MIN)
		.max(CONSEQUENCES_MAX)
		.describe(
			`${CONSEQUENCES_MIN}-${CONSEQUENCES_MAX} lines, present tense, one clause each: "Ships with cycle 1 tomorrow", "Adds 18 support tickets in week one". Make one of them the downside, because an option with only upsides is not a real choice (the API does not check this one; the human will). Where numbers trade off, give both sides with units. No semicolons and no ", and" — that is two lines, not one.`,
		),
	recommended: z
		.boolean()
		.optional()
		.describe(
			'Set true on exactly one option, the one you would take. Recommending nothing pushes the whole call back onto the human; recommending everything says nothing.',
		),
	destructive: z
		.boolean()
		.optional()
		.describe(
			'Set true on an option that cannot be undone or that reaches real people (sends, deletes, spends, ships). The human is asked to confirm it before it goes out, and it never fires from a lock-screen button alone. Leave it off for reversible choices.',
		),
	set_status: z
		.object({
			status: z.string().min(1).describe('The status to put the object in, e.g. "active".'),
			object_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'The object to move when it is not the one this comment is on, e.g. the bet a task comment is about. Defaults to the object this comment is on.',
				),
		})
		.optional()
		.describe(
			'Use on the option that moves an object to a new status ("Go" on a card asking to flip a bet to active). Tapping it makes the change as the person, only if the object is still in the status it had when you posted the card; if it has moved on, nothing changes and the person is told. Do not also flip the status yourself. All set_status options on one card must name the same object. The card drops from For You once that object leaves the status it had when posted.',
		),
})

/**
 * The text an agent proposes to send, shown on the card above the buttons so the
 * human reads it before choosing. It is deliberately NOT part of the prose rules
 * in `validateDecisionProse`: those police the agent's own wording, and a human's
 * words (a dash, a number-free sentence, an emoji) must reach the card untouched.
 *
 * The draft is normally an object whose description is the draft and nothing
 * else (`object_id`), and the feed reads that description live, so an edit made
 * after the card was posted shows on the card. `body` is only for a draft that
 * is not an object. The feed always sends `body` to the client, filled from the
 * object when there is one.
 */
/**
 * A function, not a constant: `draft` and each entry of `drafts` must be separate schema
 * instances, because the JSON Schema the MCP SDK builds turns a reused instance into a
 * `$ref`, which some agent runtimes cannot follow (see mcp tools.test.ts).
 */
function buildDecisionDraftSchema() {
	return z
		.object({
			id: z
				.string()
				.min(1)
				.max(40)
				.optional()
				.describe(
					'Only in `drafts`: a short key for this message ("kenneth", "dan-1"), unique within the card. Taking an action on the message replies with it, so you can tell which message was sent or skipped.',
				),
			object_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'The object whose description IS the draft, and nothing else (a task or content object the draft is saved on). The card shows its current description, live, so a later edit shows up. Prefer this: do not copy the text.',
				),
			file_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'The workspace file the card is about, when what you are asking about is a file and not text to send: an HTML page, a markdown document, an image, a plain-text file. The card shows the file itself (a rendered page, the formatted text, the picture) above the buttons, live, so a later version shows up. Save the file first (create_file), then give its id. Use object_id instead for a message that would be sent.',
				),
			label: z
				.string()
				.min(1)
				.max(30)
				.optional()
				.describe(
					'What kind of text it is, shown as a small label above it: "Email to Hans", "LinkedIn note", "Slack message". Plain words, at most 30 characters. Defaults to "Draft" (or the file name for a file).',
				),
			to: z
				.string()
				.min(1)
				.max(300)
				.optional()
				.describe(
					'Who it goes to, as a person would read it: "Hans Jensen, Netwerk". Leave out for a public post.',
				),
			body: z
				.string()
				.min(1)
				.max(20_000)
				.optional()
				.describe(
					'Only when the draft is not saved as an object: the exact text you will send, character for character, in the language it will be sent in. Not a summary. Ignored in favour of the object description when object_id is set and the object has one.',
				),
		})
		.refine(
			(draft) =>
				draft.object_id !== undefined || draft.body !== undefined || draft.file_id !== undefined,
			{ message: 'A draft needs object_id (preferred), file_id or body' },
		)
}

export const decisionDraftSchema = buildDecisionDraftSchema()

export const commentDecisionSchema = z
	.object({
		title: z
			.string()
			.min(1)
			.describe(
				`${TITLE_MIN_WORDS}-${TITLE_MAX_WORDS} words. The decision itself, not a status. A question if it is a judgment call ("Is the onboarding bet worth running?"), a noun phrase if it is an artifact ("Acme's note before Thursday"). No agent name, and no verb-ing: "Reviewing the funnel" is a status, not a decision.`,
			),
		summary: z
			.string()
			.min(1)
			.describe(
				`1-${SUMMARY_MAX_SENTENCES} sentences. Sentence 1: the state of the world and the cost of the status quo, with one real number you actually looked up. Sentence 2: what is already done, so the human knows they are only deciding, not working. Never restate the title.`,
			),
		ask: z
			.string()
			.min(1)
			.describe(
				'First person, one sentence. Name the single call you cannot make alone and why it belongs to the human: "Notices go to real households, so I will not send this alone." No hedging, no apologising, no offering to help.',
			),
		options: z
			.array(decisionOptionSchema)
			.min(OPTIONS_MIN)
			.max(OPTIONS_MAX)
			.describe(
				`${OPTIONS_MIN} or ${OPTIONS_MAX} options, exactly one marked recommended. These render as the buttons the human taps, so they must be the real choices rather than yes/no/maybe.`,
			),
		drafts: z
			.array(buildDecisionDraftSchema())
			.min(1)
			.max(DRAFTS_MAX)
			.optional()
			.describe(
				`Use this instead of \`draft\` when one card asks about several messages (up to ${DRAFTS_MAX}), for example five first DMs. Each message shows as its own preview with its own Send and Skip, and the human's tap on one replies to you as "Send: <label> to <to> (<id>)" or "Skip: ...". Give every message an \`id\`. The card's options still apply to the whole batch. Never put the text in the summary.`,
			),
		only_while_status: z
			.array(z.string().min(1))
			.min(1)
			.optional()
			.describe(
				'The statuses the object this comment is on must still be in for the ask to make sense, e.g. ["define"] for "flip this bet to active". The card drops from For You the moment the object is in any other status, so a card cannot outlive the state it was written about. Leave out when the ask does not depend on status.',
			),
		no_status_action: z
			.boolean()
			.optional()
			.describe(
				'Set true only when the API rejected the card for asking to change a status but the ask is about something else (for example "Park the launch email?" on a bet in a status called "launch"). Leave it off otherwise.',
			),
		status_stamp: z
			.object({ object_id: z.string().uuid(), status: z.string().min(1) })
			.optional()
			.describe(
				'Set by the API when a card has a set_status option: the object it moves and the status that object was in when the card was posted. Do not set it yourself; any value you send is replaced.',
			),
		draft: decisionDraftSchema
			.optional()
			.describe(
				"Attach this whenever the call is whether to send something in a person's name or to the outside world (an email, a message, a post). The card shows the draft above the buttons, so the human reads exactly what would go out. Without it they are approving a message they cannot see. Point at the object that holds the draft with object_id (preferred), or give the exact text as body. When the card is about a file instead (an HTML page, a markdown document, an image), give file_id and the card shows the file itself. Never put the text in the summary.",
			),
	})
	.describe(
		[
			'Attach this when you need a human to make a call, together with that human in `mentions` — a decision with an empty `mentions` array reaches nobody.',
			'It renders as a card in their For You feed: the title is the headline, the summary and ask are the body, and each option becomes a button. If the call is whether to send something, attach `draft` (the object that holds it, or the exact text) and it shows above the buttons.',
			'To ask for approval of a message: save it first as a task whose content is only the exact text, with `metadata.kind` (email, linkedin_message, linkedin_post, slack_message) and its recipient fields, then set `draft.object_id` to that task and mark exactly one option `destructive: true`, the send option. The `draft-approval-tasks` skill has the full steps.',
			'To ask whether an object should move to a new status ("flip this bet to active"), put `set_status` on the option that does it. The tap then makes the change, and the card drops once the object has left the status it had when you posted. A card that talks about changing a status without it is rejected.',
			'',
			'The API checks the rules below and rejects a decision that breaks any of them, listing every violation at once:',
			'title 3-7 words and not opening with a status verb ("Reviewing the funnel"); summary at most 2 sentences, carrying at least one digit, and not a restatement of the title;',
			'ask exactly one sentence, first person; 2-3 options with exactly one marked recommended, each label 4 words or fewer;',
			'2-3 consequence lines per option, one clause each (no semicolons, no ", and"); and nowhere in the block an em-dash, an en-dash, an emoji,',
			'or a hedge word standing in for a number ("significantly", "substantially", "several", "many", and the like).',
			'',
			'The rest is house style the API does not check. Write to it anyway, because a human reads the result:',
			'sentence case, uppercase only for micro-labels; cut every adjective that is not load-bearing; no metadiscourse,',
			'and no summarising what the human can already see on screen. If you can delete a word and the decision is still clear, delete it.',
			'',
			'Example:',
			'{ "title": "Is the onboarding bet worth running?",',
			'  "summary": "3 of 5 signups stall on step 2, costing about 40 activations a week. I have drafted the replacement copy and the migration.",',
			'  "ask": "This changes what every new customer sees first, so I will not ship it alone.",',
			'  "options": [',
			'    { "label": "7-day window", "recommended": true, "consequences": ["Ships with cycle 1 tomorrow", "Adds 18 support tickets in week one"] },',
			'    { "label": "Hold", "consequences": ["Nothing ships this cycle", "Keeps losing 40 activations a week"] } ] }',
		].join('\n'),
	)

export type CommentDecision = z.infer<typeof commentDecisionSchema>
export type DecisionDraft = z.infer<typeof decisionDraftSchema>
export type CommentDecisionOption = z.infer<typeof decisionOptionSchema>

export interface DecisionProseViolation {
	/** Dotted path into the decision object, e.g. `options.0.label`. */
	path: string
	/** Names the rule and quotes the offending value, so one retry fixes it. */
	message: string
}

function words(value: string): string[] {
	return value.trim().split(/\s+/).filter(Boolean)
}

function sentences(value: string): string[] {
	return value
		.split(/[.!?]+(?=\s|$)/)
		.map((part) => part.trim())
		.filter(Boolean)
}

function contentTokens(value: string): string[] {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((token) => token.length > 0 && !STOPWORDS.has(token))
}

/**
 * The rules that cannot be expressed as Zod structure. Returns every violation
 * rather than throwing on the first: an agent handed one nit at a time burns a
 * turn per rule.
 */
export function validateDecisionProse(decision: CommentDecision): DecisionProseViolation[] {
	const violations: DecisionProseViolation[] = []
	const add = (path: string, message: string) => violations.push({ path, message })

	// Rules that apply to every string in the block.
	const fields: Array<[string, string]> = [
		['title', decision.title],
		['summary', decision.summary],
		['ask', decision.ask],
		...decision.options.flatMap<[string, string]>((option, index) => [
			[`options.${index}.label`, option.label],
			...option.consequences.map<[string, string]>((line, lineIndex) => [
				`options.${index}.consequences.${lineIndex}`,
				line,
			]),
		]),
	]

	for (const [path, value] of fields) {
		if (value.includes('—') || value.includes('–')) {
			add(path, `Remove the dash. Rewrite as two sentences or a comma clause. Got: "${value}"`)
		}
		const emoji = value.match(/\p{Extended_Pictographic}/u)
		if (emoji) {
			add(path, `Remove the emoji ${emoji[0]}. Got: "${value}"`)
		}
		const padded = ` ${value.toLowerCase()} `
		const hedge = HEDGE_WORDS.find((word) => padded.includes(` ${word} `))
		if (hedge) {
			add(
				path,
				`Replace "${hedge}" with the actual number, or drop the claim. Numbers are concrete or absent. Got: "${value}"`,
			)
		}
	}

	const titleWords = words(decision.title)
	if (titleWords.length < TITLE_MIN_WORDS || titleWords.length > TITLE_MAX_WORDS) {
		add(
			'title',
			`Title must be ${TITLE_MIN_WORDS}-${TITLE_MAX_WORDS} words, got ${titleWords.length}: "${decision.title}"`,
		)
	}
	const firstWord = (titleWords[0] ?? '').toLowerCase().replace(/[^a-z]/g, '')
	if (firstWord.length > 4 && firstWord.endsWith('ing')) {
		add(
			'title',
			`Title opens with "${titleWords[0]}", which reads as a status rather than a decision. Ask the question or name the artifact instead. Got: "${decision.title}"`,
		)
	}

	const summarySentences = sentences(decision.summary)
	if (summarySentences.length > SUMMARY_MAX_SENTENCES) {
		add(
			'summary',
			`Summary must be at most ${SUMMARY_MAX_SENTENCES} sentences, got ${summarySentences.length}: "${decision.summary}"`,
		)
	}
	if (!/\d/.test(decision.summary)) {
		add(
			'summary',
			`Summary must carry one real number for the cost of the status quo. Got no digits: "${decision.summary}"`,
		)
	}
	const titleTokens = contentTokens(decision.title)
	if (titleTokens.length > 0) {
		const summaryTokens = new Set(contentTokens(decision.summary))
		const shared = titleTokens.filter((token) => summaryTokens.has(token)).length
		if (shared / titleTokens.length >= 0.8) {
			add(
				'summary',
				`Summary restates the title. Give the state of the world and what you have already done instead. Title: "${decision.title}" Summary: "${decision.summary}"`,
			)
		}
	}

	const askSentences = sentences(decision.ask)
	if (askSentences.length > 1) {
		add('ask', `Ask must be one sentence, got ${askSentences.length}: "${decision.ask}"`)
	}
	if (!/\bI\b|\bI'|\bmy\b/.test(decision.ask)) {
		add(
			'ask',
			`Ask must be first person, naming the call you cannot make alone. Got: "${decision.ask}"`,
		)
	}

	const recommended = decision.options.filter((option) => option.recommended).length
	if (recommended !== 1) {
		add(
			'options',
			`Exactly one option must be marked recommended, got ${recommended}. Say which one you would take.`,
		)
	}
	decision.options.forEach((option, index) => {
		const labelWords = words(option.label)
		if (labelWords.length > OPTION_LABEL_MAX_WORDS) {
			add(
				`options.${index}.label`,
				`Option label must be ${OPTION_LABEL_MAX_WORDS} words or fewer, got ${labelWords.length}: "${option.label}"`,
			)
		}
		option.consequences.forEach((line, lineIndex) => {
			if (line.includes(';') || /,\s+and\b/.test(line)) {
				add(
					`options.${index}.consequences.${lineIndex}`,
					`Consequence must be one clause. Split it into two lines. Got: "${line}"`,
				)
			}
		})
	})

	return violations
}

// Words that ask for a status change. "next to" a status name of the object's type, they mean the
// card wants the object moved.
const STATUS_VERBS = new Set(['flip', 'move', 'promote', 'park', 'set'])
const STATUS_VERB_WINDOW = 5

/**
 * A card that asks for a status change in words but has no set_status option. Such a card stays
 * on For You after the status has moved, and its tap does nothing. Needs the status names of the
 * object's type, so it cannot sit in `validateDecisionProse`. Narrow on purpose: a verb from STATUS_VERBS
 * within a few words of a status name, and never on a card that carries a draft ("Park the
 * launch email?"). `no_status_action` is the opt-out for a false match.
 */
export function findStatusActionViolations(
	decision: CommentDecision,
	statuses: readonly string[],
): DecisionProseViolation[] {
	if (decision.no_status_action || decision.draft || decision.drafts?.length) return []
	if (decision.options.some((option) => option.set_status)) return []

	const names = statuses.map((status) => status.toLowerCase().replace(/_/g, ' '))
	const fields: Array<[string, string]> = [
		['title', decision.title],
		['ask', decision.ask],
		...decision.options.map<[string, string]>((option, index) => [
			`options.${index}.label`,
			option.label,
		]),
	]
	for (const [path, value] of fields) {
		const tokens =
			value
				.toLowerCase()
				.replace(/_/g, ' ')
				.match(/[a-z0-9]+/g) ?? []
		for (let i = 0; i < tokens.length; i++) {
			if (!STATUS_VERBS.has(tokens[i] as string)) continue
			const near = tokens.slice(i + 1, i + 1 + STATUS_VERB_WINDOW)
			const status = names.find((name) => {
				const parts = name.split(' ')
				return near.some((_, at) => parts.every((part, k) => near[at + k] === part))
			})
			if (!status) continue
			return [
				{
					path,
					message: `This card asks to change a status ("${tokens[i]}" ... "${status}") but no option has set_status, so the card would outlive the change and the tap would do nothing. Put it on the option that does it, e.g. { "label": "Go", "set_status": { "status": "${status.replace(/ /g, '_')}" }, ... }, and add "object_id" inside set_status when the object is not the one this comment is on. If the ask is about something else, set no_status_action: true. Got: "${value}"`,
				},
			]
		}
	}
	return []
}

/**
 * The decision block carried by a comment's event data, or `null` if there is
 * none that parses.
 *
 * This is the single definition of "this comment asked the reader to make a
 * call". It exists because there were briefly three: the feed parsed with the
 * schema while the object timeline and the orphan-thread detector each tested
 * `x && typeof x === 'object'`, which also admits `[]`, `{}` and `new Date()`.
 * A comment carrying `decision: {}` therefore rendered as a plain thread in the
 * feed, as a decision point on the timeline, and counted as `decision_required`
 * in the ledger. Parse in one place so every surface agrees.
 */
export function parseCommentDecision(value: unknown): CommentDecision | null {
	const parsed = commentDecisionSchema.safeParse(value)
	return parsed.success ? parsed.data : null
}
