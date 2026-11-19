import { z } from 'zod'

/** Who checks a line: the system from a reading, a second agent, or a person. */
export const DONE_WHEN_CHECKERS = ['code', 'checker', 'person'] as const
export type DoneWhenChecker = (typeof DONE_WHEN_CHECKERS)[number]

/** A line's state. A person ticks it, or the outcome check writes it when an agent asks to close the job. */
export const DONE_WHEN_STATES = ['true', 'false', 'cannot_tell', 'not_checked'] as const
export type DoneWhenState = (typeof DONE_WHEN_STATES)[number]

export const DONE_WHEN_LIST_STATUSES = ['draft', 'approved', 'superseded'] as const
export type DoneWhenListStatus = (typeof DONE_WHEN_LIST_STATUSES)[number]

export const DONE_WHEN_LINES_MIN = 1
export const DONE_WHEN_LINES_MAX = 8
export const DONE_WHEN_QUESTIONS_MAX = 4

/** Object types whose done-when list may never be skipped. */
export const DONE_WHEN_NO_SKIP_TYPES = ['bet', 'target'] as const

export const doneWhenLineInputSchema = z.object({
	text: z
		.string()
		.min(1)
		.max(300)
		.describe(
			'One thing that will be true when the job is done, in plain words a person can check ("The first 10 emails are sent and logged"). Not a step.',
		),
	checked_by: z
		.enum(DONE_WHEN_CHECKERS)
		.describe(
			'Who checks the line. code: only with a reading the system takes by itself (give reading and comparison). checker: a second agent reads the result. person: a person looks; the default when there is no reading.',
		),
	needs_yes: z
		.boolean()
		.optional()
		.describe(
			"True when making the line true sends something in a person’s name, spends money or deletes something. The card's go-ahead never covers it.",
		),
	reading: z
		.string()
		.min(1)
		.max(300)
		.optional()
		.describe('code lines only: what the system reads, e.g. "Stripe payments in the last 7 days".'),
	comparison: z
		.string()
		.min(1)
		.max(100)
		.optional()
		.describe('code lines only: how the reading is compared, e.g. ">= 3".'),
})

/**
 * The block an agent adds to a decision card to propose a job's done-when list. Posting the card
 * writes the draft rows; a person's tap on the option with approve_done_when approves them.
 */
export const doneWhenBlockSchema = z.object({
	questions: z
		.array(z.string().min(1).max(200))
		.max(DONE_WHEN_QUESTIONS_MAX)
		.optional()
		.describe(
			`Questions about the goal to answer before writing the lines, all at once, shown at the top of the card (up to ${DONE_WHEN_QUESTIONS_MAX}).`,
		),
	lines: z
		.array(doneWhenLineInputSchema)
		.min(DONE_WHEN_LINES_MIN)
		.max(DONE_WHEN_LINES_MAX)
		.describe(
			`The done-when list, ${DONE_WHEN_LINES_MIN} to ${DONE_WHEN_LINES_MAX} lines: what "done" means for this job.`,
		),
})

export type DoneWhenBlock = z.infer<typeof doneWhenBlockSchema>
export type DoneWhenLineInput = z.infer<typeof doneWhenLineInputSchema>

/** The prose of a block, for the card's wording rules. Path is relative to done_when. */
export function doneWhenStrings(block: DoneWhenBlock): Array<[string, string]> {
	return [
		...(block.questions ?? []).map<[string, string]>((q, i) => [`questions.${i}`, q]),
		...block.lines.flatMap<[string, string]>((line, i) => [
			[`lines.${i}.text`, line.text],
			...(line.reading ? ([[`lines.${i}.reading`, line.reading]] as Array<[string, string]>) : []),
		]),
	]
}

/** Rules Zod cannot say: a reading belongs only to a code line. */
export function findDoneWhenViolations(
	block: DoneWhenBlock,
): Array<{ path: string; message: string }> {
	const out: Array<{ path: string; message: string }> = []
	block.lines.forEach((line, i) => {
		if (line.checked_by === 'code' && !line.reading) {
			out.push({
				path: `lines.${i}.reading`,
				message: `A code line needs a reading and a comparison. With no reading behind it the line is checked_by person. Got: "${line.text}"`,
			})
		}
		if (line.checked_by !== 'code' && (line.reading || line.comparison)) {
			out.push({
				path: `lines.${i}.checked_by`,
				message: `reading and comparison belong to a code line only. Got: "${line.text}"`,
			})
		}
	})
	return out
}

export const skipDoneWhenSchema = z.object({
	reason: z
		.string()
		.min(1)
		.max(300)
		.describe(
			'Why this job needs no done-when list, in one sentence: "one session finishes it, it undoes cleanly, nothing is sent, spent or deleted". Refused on a bet, a target or a job given as a goal.',
		),
})

export const setDoneWhenLineSchema = z.object({
	state: z.enum(DONE_WHEN_STATES),
})

export const doneWhenLineResponseSchema = z.object({
	id: z.string().uuid(),
	position: z.number().int(),
	text: z.string(),
	checked_by: z.enum(DONE_WHEN_CHECKERS),
	needs_yes: z.boolean(),
	reading: z.string().nullable(),
	comparison: z.string().nullable(),
	state: z.enum(DONE_WHEN_STATES),
	state_set_at: z.string().nullable(),
})

export const doneWhenResponseSchema = z.object({
	object_id: z.string().uuid(),
	status: z.enum(['draft', 'approved']),
	version: z.number().int(),
	approved_by: z.string().uuid().nullable(),
	approved_by_name: z.string().nullable(),
	approved_at: z.string().nullable(),
	lines: z.array(doneWhenLineResponseSchema),
	true_count: z.number().int(),
	total: z.number().int(),
})

export const doneWhenSkipResponseSchema = z.object({
	object_id: z.string().uuid(),
	reason: z.string(),
	skipped_by: z.string().uuid(),
	skipped_at: z.string(),
})

export type DoneWhenResponse = z.infer<typeof doneWhenResponseSchema>
export type DoneWhenLineResponse = z.infer<typeof doneWhenLineResponseSchema>
export type DoneWhenSkipResponse = z.infer<typeof doneWhenSkipResponseSchema>
