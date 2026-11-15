import { z } from 'zod'

/**
 * The outcome check: when an agent asks to close a job that has an approved done-when list, the
 * server holds the request and marks every line. See apps/dev/src/lib/outcome-check.ts.
 */

/** How a job's checking ended. "Accepted by a person" is not one of them and is never set by a check. */
export const OUTCOME_ENDINGS = [
	'checks_passed',
	'sent_back',
	'round_limit_reached',
	'list_does_not_fit',
	'stopped_by_person',
] as const
export type OutcomeEnding = (typeof OUTCOME_ENDINGS)[number]

/** Endings only a person can set. */
export const OUTCOME_PERSON_ENDINGS = ['list_does_not_fit', 'stopped_by_person'] as const

export const OUTCOME_MARKS = ['yes', 'no', 'cannot_tell'] as const
export type OutcomeMark = (typeof OUTCOME_MARKS)[number]

/** Who made a mark. */
export const OUTCOME_MARKERS = ['code', 'checker', 'person'] as const
export type OutcomeMarker = (typeof OUTCOME_MARKERS)[number]

/** round: a check the server ran. blind: a person's mark of the same lines, made without seeing the checker's. */
export const OUTCOME_CHECK_KINDS = ['round', 'blind'] as const
export type OutcomeCheckKind = (typeof OUTCOME_CHECK_KINDS)[number]

/** A failed round is a sent_back one. Round 4 does not start. */
export const OUTCOME_MAX_ROUNDS = 3

/** A reading older than this is stale: its line says cannot_tell, never yes. */
export const OUTCOME_READING_MAX_AGE_MS = 30 * 60 * 1000

/**
 * The statuses an agent may only reach through the check, per type. The statuses that end work
 * without claiming the result was reached (discarded, archived, failed, paused, missed, dropped)
 * are not held: stopping is never punished.
 */
export const GATED_CLOSE_STATUSES_BY_TYPE: Record<string, string[]> = {
	task: ['done', 'validated'],
	bet: ['succeeded'],
	target: ['hit'],
}

export function isGatedCloseStatus(type: string, status: string): boolean {
	return (GATED_CLOSE_STATUSES_BY_TYPE[type] ?? []).includes(status)
}

export const outcomeMarkEntrySchema = z.object({
	line_id: z.string().uuid(),
	mark: z.enum(OUTCOME_MARKS),
	by: z.enum(OUTCOME_MARKERS),
	/** The checker's or the reading's reason, one sentence. Never the agent's own words. */
	reason: z.string().max(500).optional(),
	/** Who the person was, for a mark made by a person. */
	person_id: z.string().uuid().optional(),
})
export type OutcomeMarkEntry = z.infer<typeof outcomeMarkEntrySchema>

export const outcomeReadingUsedSchema = z.object({
	line_id: z.string().uuid(),
	measure: z.string(),
	value: z.number(),
	read_at: z.string(),
	source: z.string(),
})
export type OutcomeReadingUsed = z.infer<typeof outcomeReadingUsedSchema>

export const outcomeCheckResponseSchema = z.object({
	id: z.string().uuid(),
	object_id: z.string().uuid(),
	kind: z.enum(OUTCOME_CHECK_KINDS),
	round: z.number().int().nullable(),
	marks: z.array(outcomeMarkEntrySchema),
	readings: z.array(outcomeReadingUsedSchema),
	ending: z.enum(OUTCOME_ENDINGS).nullable(),
	flags: z.array(z.string()),
	checker_model: z.string().nullable(),
	created_at: z.string(),
})
export type OutcomeCheckResponse = z.infer<typeof outcomeCheckResponseSchema>

export const outcomeStateResponseSchema = z.object({
	object_id: z.string().uuid(),
	/** How checking ended, or null while it has not. */
	ending: z.enum(OUTCOME_ENDINGS).nullable(),
	ended_at: z.string().nullable(),
	/** Set only by a person. Separate from the ending: a check never sets it. */
	accepted_by: z.string().uuid().nullable(),
	accepted_at: z.string().nullable(),
	rounds: z.array(outcomeCheckResponseSchema),
})
export type OutcomeStateResponse = z.infer<typeof outcomeStateResponseSchema>

export const endOutcomeSchema = z.object({
	ending: z.enum(OUTCOME_PERSON_ENDINGS),
})

/** A person's mark of one line on a piece of work, made without seeing the checker's marks. */
export const blindMarkSchema = z.object({
	marks: z
		.array(z.object({ line_id: z.string().uuid(), mark: z.enum(['yes', 'no']) }))
		.min(1)
		.max(8),
})
