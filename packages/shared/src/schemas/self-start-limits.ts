import { z } from 'zod'

/**
 * Why a session started. Recorded once per session in `sessions.config.start_reason` by
 * startSession(), the one entry point. A caller that knows better than the classifier (the sweep,
 * a wake on change, a sent-back turn) passes its own `config.start_reason`.
 *
 * `person`          a person asked: a chat turn, or a request/mention/reply written by a human
 * `agent_request`   another agent asked: an @mention, a thread reply, a spawn
 * `trigger_event`   an event trigger fired (a state change)
 * `trigger_cron`    a cron trigger fired
 * `self_wakeup`     a one-shot reminder the agent set for itself
 * `task_restart`    the platform restarted a session that ended with its task still in progress
 * `retry`           the retry scheduler re-ran a failed session
 * `sweep`           the sweep for overdue next steps
 * `driver_wake`     the driver was woken because something it drives changed
 * `sent_back`       the end-of-turn check sent the turn back
 * `internal`        onboarding, bootstrap and other platform-made sessions
 */
export const SESSION_START_REASONS = [
	'person',
	'agent_request',
	'trigger_event',
	'trigger_cron',
	'self_wakeup',
	'task_restart',
	'retry',
	'sweep',
	'driver_wake',
	'sent_back',
	'internal',
] as const

export const sessionStartReasonSchema = z.enum(SESSION_START_REASONS)
export type SessionStartReason = z.infer<typeof sessionStartReasonSchema>

/** Reasons the daily budget and the back-off count: nobody asked for these runs in the moment. */
export const SELF_STARTED_REASONS: readonly SessionStartReason[] = [
	'agent_request',
	'trigger_event',
	'trigger_cron',
	'self_wakeup',
	'task_restart',
	'sweep',
	'driver_wake',
	'sent_back',
]

/** Reasons that continue earlier work on an object and so carry a cap in a row. */
export const CONTINUATION_REASONS: readonly SessionStartReason[] = [
	'self_wakeup',
	'task_restart',
	'sweep',
	'driver_wake',
	'sent_back',
]

/** At most this many automatic continuations of one reason in a row on one object. */
export const MAX_AUTOMATIC_CONTINUATIONS = 2

/**
 * The daily token budget per agent for self-started runs. Stored under
 * `settings.agent_daily_budget`; absent means no per-agent limit is enforced (the amount is set
 * by a person, not by the platform). `per_agent` wins over `default_tokens`. The day is the
 * workspace's budget day (`settings.daily_budget.timezone`, UTC when there is none).
 *
 * `warn_only_until` maps an agent id to a time. Until then that agent's runs are never refused at
 * the limit: the 80% warning and an over-the-limit warning still go out. From that time on the
 * stop applies by itself, with no change needed.
 */
export const agentDailyBudgetSchema = z.object({
	default_tokens: z.number().int().positive().max(1_000_000_000_000).optional(),
	per_agent: z
		.record(z.string().uuid(), z.number().int().positive().max(1_000_000_000_000))
		.optional(),
	warn_only_until: z.record(z.string().uuid(), z.string().datetime({ offset: true })).optional(),
})

export type AgentDailyBudget = z.infer<typeof agentDailyBudgetSchema>
