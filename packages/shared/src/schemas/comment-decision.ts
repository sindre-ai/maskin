import { z } from 'zod'
import { doneWhenBlockSchema, doneWhenStrings, findDoneWhenViolations } from './done-when'

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

const TITLE_MIN_WORDS = 2
const TITLE_MAX_WORDS = 9
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
			`${OPTION_LABEL_MAX_WORDS} words or fewer, sentence case. The choice itself ("7-day window", "Hold"), not a sentence.`,
		),
	consequences: z
		.array(z.string().min(1))
		.min(CONSEQUENCES_MIN)
		.max(CONSEQUENCES_MAX)
		.describe(
			`${CONSEQUENCES_MIN}-${CONSEQUENCES_MAX} lines, present tense, one clause each ("Ships with cycle 1 tomorrow"). Put guardrails here and make one a downside. No semicolons and no ", and".`,
		),
	recommended: z
		.boolean()
		.optional()
		.describe('Set true on exactly one option, the one you would take.'),
	destructive: z
		.boolean()
		.optional()
		.describe(
			'Set true on an option that cannot be undone or reaches real people (sends, deletes, spends, ships). The human must confirm it.',
		),
	default_on_silence: z
		.boolean()
		.optional()
		.describe(
			'Set true on the one option taken if nobody answers by expires_at (needs expires_at). You are woken once at the deadline. Reversible options only: refused on a card with a destructive or delete_agent option, a draft, or a set_status default.',
		),
	set_status: z
		.object({
			status: z.string().min(1).describe('The status to put the object in, e.g. "active".'),
			object_id: z
				.string()
				.uuid()
				.optional()
				.describe('The object to move, if not the one this comment is on.'),
		})
		.optional()
		.describe(
			'On the option that moves an object to a new status. The tap makes the change as the person, only if the object is still in the status it had when you posted. Do not also flip it yourself. All set_status options on a card name the same object.',
		),
	approve_done_when: z
		.boolean()
		.optional()
		.describe(
			'Set true on the one option that approves the done-when list (needs done_when). Only a person tapping it approves; it also gives the go-ahead for every line that does not send, spend or delete.',
		),
	delete_agent: z
		.object({
			actor_id: z.string().uuid().describe('The agent to delete: its id from list_actors.'),
		})
		.optional()
		.describe(
			'On the option that approves deleting another agent; mark it destructive. The tap only records approval: the reply wakes you, then call delete_agent with the same id within 24 hours. Not for yourself or a system agent. All delete_agent options on a card name the same agent.',
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
					'Only in `drafts`: a short key for this message ("dan-1"), unique within the card. The reply to Send or Skip carries it.',
				),
			object_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'The object whose description IS the draft and nothing else. The card shows it live. Preferred over body.',
				),
			file_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'The workspace file the card is about (HTML page, markdown, image, text), shown live above the buttons. Save it first with create_file. For a message to send use object_id.',
				),
			label: z
				.string()
				.min(1)
				.max(30)
				.optional()
				.describe(
					'Short label shown above it ("Email to Hans"), 30 characters at most. Defaults to "Draft" or the file name.',
				),
			to: z
				.string()
				.min(1)
				.max(300)
				.optional()
				.describe('Who it goes to ("Hans Jensen, Netwerk"). Leave out for a public post.'),
			body: z
				.string()
				.min(1)
				.max(20_000)
				.optional()
				.describe(
					'Only when the draft is not an object: the exact text you will send, not a summary. Ignored when object_id is set and the object has a description.',
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
				`${TITLE_MAX_WORDS} words or fewer, ending in "?". The question the human is asked, not a status ("Reviewing the funnel"). No agent name.`,
			),
		summary: z
			.string()
			.min(1)
			.describe(
				`At most ${SUMMARY_MAX_SENTENCES} sentences: what is done and what is still open. Use a real number only if you looked it up. No source paths or file names. Do not name the object. Never restate the title.`,
			),
		ask: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Leave out when the title is already the question. Otherwise first person, one sentence: the single call you cannot make alone and why it is the human's. No hedging or apologising.",
			),
		options: z
			.array(decisionOptionSchema)
			.min(OPTIONS_MIN)
			.max(OPTIONS_MAX)
			.describe(
				`${OPTIONS_MIN} or ${OPTIONS_MAX} options, exactly one marked recommended. They render as the buttons the human taps, so make them the real choices.`,
			),
		drafts: z
			.array(buildDecisionDraftSchema())
			.min(1)
			.max(DRAFTS_MAX)
			.optional()
			.describe(
				`Use instead of \`draft\` for several messages (up to ${DRAFTS_MAX}). Each gets its own preview with Send and Skip, and the reply names it by \`id\`, so give every message one. The card's options apply to the whole batch.`,
			),
		only_while_status: z
			.array(z.string().min(1))
			.min(1)
			.optional()
			.describe(
				'Statuses the object must still be in for the ask to make sense, e.g. ["define"]. The card drops from For You once it is in any other status. Leave out and it drops when the object leaves the status it had when you posted (see keep_on_status_change).',
			),
		keep_on_status_change: z
			.boolean()
			.optional()
			.describe(
				'Set true only when the card must stay on For You after the object changes status, e.g. you move the task on while the person is still deciding.',
			),
		expires_at: z
			.string()
			.datetime({ offset: true })
			.optional()
			.describe(
				'ISO 8601 date-time after which the ask is moot, e.g. "2026-10-29T17:00:00Z". Set it whenever an option or the ask names a deadline; the card then leaves For You. Must be in the future.',
			),
		no_status_action: z
			.boolean()
			.optional()
			.describe(
				'Set true only when the API rejected the card for asking to change a status but the ask is about something else.',
			),
		status_stamp: z
			.object({ object_id: z.string().uuid(), status: z.string().min(1) })
			.optional()
			.describe(
				"Set by the API: the card's object and its status when posted. Do not set it; any value you send is replaced.",
			),
		done_when: doneWhenBlockSchema
			.optional()
			.describe(
				"Propose the done-when list for a job: what will be true when the work is done, each line tagged Code, Checker or You. Posting saves a draft; a person tapping the approve_done_when option approves it. You cannot approve or edit an approved list; if they reply with changes, post a new card. The job is the comment's object.",
			),
		draft: decisionDraftSchema
			.optional()
			.describe(
				"Attach this whenever the call is whether to send something in a person's name or to the outside world, so the human reads exactly what would go out. Give object_id (preferred), file_id or the exact text as body. Never put the text in the summary.",
			),
	})
	.describe(
		[
			'Attach this when you need a human to make a call, together with that human in `mentions` (a decision with empty `mentions` reaches nobody). It renders as a card in their For You feed: title as headline, summary and ask as body, each option a button.',
			'To ask approval of a message, save it first as a task whose content is only the exact text, with `metadata.kind` (email, linkedin_message, linkedin_post, slack_message) and its recipient fields; set `draft.object_id` to that task and mark exactly one option `destructive: true`, the send option. See the `draft-approval-tasks` skill.',
			'A new card withdraws your earlier cards on the same object. To ask whether an object should change status, put `set_status` on the option that does it; a card that talks about a status change without it is rejected.',
			'The API rejects a decision that breaks its rules and lists every violation: title 9 words or fewer ending in "?", summary at most 2 sentences, 2-3 options with 2-3 one-clause consequences each, no em-dash, en-dash, emoji or hedge word ("several", "many") standing in for a number.',
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
export function validateDecisionProse(
	decision: CommentDecision,
	now: Date = new Date(),
): DecisionProseViolation[] {
	const violations: DecisionProseViolation[] = []
	const add = (path: string, message: string) => violations.push({ path, message })

	// Rules that apply to every string in the block.
	const fields: Array<[string, string]> = [
		['title', decision.title],
		['summary', decision.summary],
		...(decision.ask === undefined ? [] : ([['ask', decision.ask]] as Array<[string, string]>)),
		...(decision.done_when
			? doneWhenStrings(decision.done_when).map<[string, string]>(([path, value]) => [
					`done_when.${path}`,
					value,
				])
			: []),
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

	if (decision.expires_at && new Date(decision.expires_at).getTime() <= now.getTime()) {
		add(
			'expires_at',
			`expires_at must be in the future, or the card would never show. Got: "${decision.expires_at}"`,
		)
	}

	if (decision.done_when) {
		for (const found of findDoneWhenViolations(decision.done_when)) {
			add(`done_when.${found.path}`, found.message)
		}
	}
	const approving = decision.options.filter((option) => option.approve_done_when)
	if (approving.length > 0 && !decision.done_when) {
		add(
			'options',
			'approve_done_when needs a done_when block on the same card. Add the lines, or drop approve_done_when.',
		)
	}
	if (decision.done_when && approving.length !== 1) {
		add(
			'options',
			`A card with done_when needs exactly one option with approve_done_when, got ${approving.length}.`,
		)
	}
	violations.push(...findDefaultOnSilenceViolations(decision))

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
	if (/(?:^|\s)(?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5}\b/i.test(decision.summary)) {
		add(
			'summary',
			`Summary must not carry a source path or file name. Say what changed in words. Got: "${decision.summary}"`,
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

	if (!decision.title.trim().endsWith('?')) {
		add('title', `Title must be the question and end in "?". Got: "${decision.title}"`)
	}

	if (decision.ask !== undefined) {
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

/** The option a card names as its default on silence, or null when it names none. */
export function findDefaultOnSilenceOption(
	decision: Pick<CommentDecision, 'options'> | null | undefined,
): CommentDecisionOption | null {
	return decision?.options.find((option) => option.default_on_silence) ?? null
}

/**
 * The rules for a default on silence. It needs a deadline and one option, and it is refused on any
 * card that could send, spend or delete: a person must say yes to those, so silence never does.
 * The whole card is refused, not only the default option, so "Send" next to a harmless "Hold" with
 * the default on "Hold" is still refused: the card exists to get a yes to the send.
 */
function findDefaultOnSilenceViolations(decision: CommentDecision): DecisionProseViolation[] {
	const defaults = decision.options.flatMap((option, index) =>
		option.default_on_silence ? [index] : [],
	)
	if (defaults.length === 0) return []
	const path = `options.${defaults[0]}.default_on_silence`
	const violations: DecisionProseViolation[] = []
	if (defaults.length > 1) {
		violations.push({
			path,
			message: `Only one option can be the default on silence, got ${defaults.length}. Keep it on the option you would take.`,
		})
	}
	if (!decision.expires_at) {
		violations.push({
			path,
			message:
				'A default on silence needs expires_at: it happens when that time passes with no answer. Set expires_at, or drop default_on_silence.',
		})
	}
	const chosen = decision.options[defaults[0] as number] as CommentDecisionOption
	if (chosen.set_status) {
		violations.push({
			path,
			message: `"${chosen.label}" moves a status, which a person decides. Put the default on an option that changes nothing, or drop default_on_silence.`,
		})
	}
	if (
		decision.options.some((option) => option.destructive || option.delete_agent) ||
		decision.draft ||
		decision.drafts?.length
	) {
		violations.push({
			path,
			message:
				'A card that sends, spends or deletes never gets a default on silence: it has a destructive option, a delete_agent option or a draft. Drop default_on_silence and wait for the answer.',
		})
	}
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
		...(decision.ask === undefined ? [] : ([['ask', decision.ask]] as Array<[string, string]>)),
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

/** Whether the card's `expires_at` has passed. A card without one never expires. */
export function isDecisionExpired(
	decision: Pick<CommentDecision, 'expires_at'> | null | undefined,
	now: Date = new Date(),
): boolean {
	return !!decision?.expires_at && new Date(decision.expires_at).getTime() <= now.getTime()
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
