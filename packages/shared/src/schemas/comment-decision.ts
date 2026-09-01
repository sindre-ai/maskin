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
})

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
	})
	.describe(
		[
			'Attach this when you need a human to make a call, together with that human in `mentions` — a decision with an empty `mentions` array reaches nobody.',
			'It renders as a card in their For You feed: the title is the headline, the summary and ask are the body, and each option becomes a button.',
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
