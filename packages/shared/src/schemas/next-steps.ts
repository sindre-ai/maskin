import { z } from 'zod'

/** `open` and `blocked` are the live states: an object has at most one of them. */
export const NEXT_STEP_STATUSES = ['open', 'blocked', 'done', 'skipped'] as const
export type NextStepStatus = (typeof NEXT_STEP_STATUSES)[number]

export const NEXT_STEP_ACTION_MAX_CHARS = 500
export const NEXT_STEP_TEXT_MAX_CHARS = 1000

const actionField = z
	.string()
	.trim()
	.min(1)
	.max(NEXT_STEP_ACTION_MAX_CHARS)
	.describe('The next action, one short sentence: what happens next.')

const dueAtField = z
	.string()
	.datetime({ offset: true })
	.describe('When it should happen, an ISO 8601 time with a timezone, e.g. 2026-11-14T09:00:00Z.')

const ownerField = z
	.string()
	.uuid()
	.describe('Who does it: an agent or a person in the workspace (actor id).')

const blockedOnFields = {
	blocked_on_object_id: z
		.string()
		.uuid()
		.optional()
		.describe('Blocked on this object (a task, a blocker). Give at most one blocked_on field.'),
	blocked_on_actor_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			'Blocked on an answer from this agent or person. Needs blocked_reason holding the question.',
		),
	blocked_on_decision_comment_id: z
		.number()
		.int()
		.positive()
		.optional()
		.describe('Blocked on this decision card (the comment id create_comment returned).'),
	blocked_reason: z
		.string()
		.trim()
		.min(1)
		.max(NEXT_STEP_TEXT_MAX_CHARS)
		.optional()
		.describe('One line on what it waits for. The question itself when blocked on an actor.'),
}

/** Create the next step on an object. Refused while the object has an open or blocked one. */
export const setNextStepSchema = z.object({
	action: actionField,
	due_at: dueAtField,
	owner_id: ownerField
		.optional()
		.describe('Who does it. Defaults to you. Give an agent or a person in the workspace.'),
	...blockedOnFields,
	replace: z
		.boolean()
		.default(false)
		.describe(
			'Set true to replace the current open or blocked step: it is closed as skipped and this one takes its place.',
		),
})

/**
 * The shortest wait a self-set wake-up may have. Anything sooner is better done by carrying on in
 * the current turn, and a very short timer is how a run ends up waking itself in a loop.
 */
export const MIN_WAKE_LEAD_MINUTES = 5

/** Set the next step and make sure someone comes back for it, in one call. */
export const scheduleNextStepSchema = z.object({
	action: actionField,
	due_at: dueAtField.describe(
		`When to come back, an ISO 8601 time with a timezone, e.g. 2026-11-14T09:00:00Z. At least ${MIN_WAKE_LEAD_MINUTES} minutes from now when you are the owner.`,
	),
	owner_id: ownerField
		.optional()
		.describe(
			'Who does it. Defaults to you: you are woken at due_at on this object. Another agent: a task is created for them and the step waits on it. A person: the step is stored and nobody is woken.',
		),
	replace: z
		.boolean()
		.default(false)
		.describe(
			'Set true to replace the current open or blocked step: it is closed as skipped and its wake-up is cancelled.',
		),
})

/** Change or close the object's current (open or blocked) step. Every field is optional. */
export const updateNextStepSchema = z.object({
	action: actionField.optional(),
	due_at: dueAtField.optional(),
	owner_id: ownerField.optional(),
	status: z
		.enum(NEXT_STEP_STATUSES)
		.optional()
		.describe(
			'open, blocked, done or skipped. done and skipped close the step and need evidence. blocked needs exactly one blocked_on field.',
		),
	evidence: z
		.string()
		.trim()
		.min(1)
		.max(NEXT_STEP_TEXT_MAX_CHARS)
		.optional()
		.describe('What shows it is done (a link, a result), or why it was skipped.'),
	...blockedOnFields,
})

export const nextStepResponseSchema = z.object({
	id: z.string().uuid(),
	object_id: z.string().uuid(),
	action: z.string(),
	owner_id: z.string().uuid().nullable(),
	due_at: z.string(),
	status: z.enum(NEXT_STEP_STATUSES),
	blocked_on_object_id: z.string().uuid().nullable(),
	blocked_on_actor_id: z.string().uuid().nullable(),
	blocked_on_decision_comment_id: z.number().nullable(),
	blocked_reason: z.string().nullable(),
	evidence: z.string().nullable(),
	wake_count: z.number(),
	created_by: z.string().uuid().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
	closed_at: z.string().nullable(),
})

/** What backs the step: a timer for the owner, a task for another agent, or nothing for a person. */
export const scheduleNextStepResponseSchema = z.object({
	next_step: nextStepResponseSchema,
	wake_up: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('reminder'), trigger_id: z.string().uuid(), at: z.string() }),
		z.object({ kind: z.literal('task'), task_id: z.string().uuid() }),
		z.object({ kind: z.literal('none'), reason: z.string() }),
	]),
})

export type ScheduleNextStepInput = z.infer<typeof scheduleNextStepSchema>
export type SetNextStepInput = z.infer<typeof setNextStepSchema>
export type UpdateNextStepInput = z.infer<typeof updateNextStepSchema>
export type ScheduleNextStepResponse = z.infer<typeof scheduleNextStepResponseSchema>
export type NextStepResponse = z.infer<typeof nextStepResponseSchema>
