/**
 * The one place that decides what "Needs you / In progress / New / Done /
 * Archived" means for search. The search endpoint stamps `statusGroup` on every
 * row and filters and counts on it; the web imports only the keys, labels and
 * order, so the two can never drift apart.
 *
 * Statuses are workspace-configurable per type and drift from the code, so the
 * lookup is: explicit (type, status) table, then a text rule that reads the raw
 * status, then In progress. It never throws on an unknown status.
 */

/** Wire values, in display order. */
export const STATUS_GROUP_KEYS = ['needs_you', 'in_progress', 'new', 'done', 'archived'] as const

export type StatusGroupKey = (typeof STATUS_GROUP_KEYS)[number]

export const STATUS_GROUP_LABELS: Record<StatusGroupKey, string> = {
	needs_you: 'Needs you',
	in_progress: 'In progress',
	new: 'New',
	done: 'Done',
	archived: 'Archived',
}

/** Key and label for each group, in display order. */
export const STATUS_GROUPS: ReadonlyArray<{ key: StatusGroupKey; label: string }> =
	STATUS_GROUP_KEYS.map((key) => ({ key, label: STATUS_GROUP_LABELS[key] }))

export function isStatusGroupKey(value: unknown): value is StatusGroupKey {
	return typeof value === 'string' && (STATUS_GROUP_KEYS as readonly string[]).includes(value)
}

/**
 * Explicit mapping for the known (type, status) pairs: group to the statuses in
 * it, per type. Object types come from the default workspace statuses. The
 * non-object sources use the type keys `chat`, `agent` and `automation`, with a
 * raw status derived from their own state: a chat is unread, read or archived;
 * an agent has its agent_state; an automation is on or off (its enabled flag).
 */
const GROUP_STATUSES_BY_TYPE: Record<string, Partial<Record<StatusGroupKey, readonly string[]>>> = {
	bet: {
		new: ['signal'],
		in_progress: ['define', 'active', 'live'],
		done: ['succeeded', 'failed'],
		archived: ['paused', 'archived'],
	},
	insight: {
		new: ['new'],
		in_progress: ['processing', 'clustered', 'scored'],
		archived: ['parked', 'discarded'],
	},
	task: {
		new: ['backlog', 'todo'],
		in_progress: ['in_progress'],
		needs_you: ['in_review'],
		done: ['validated', 'done'],
		archived: ['discarded'],
	},
	loop: {
		new: ['draft'],
		in_progress: ['pilot', 'learning', 'supervised', 'live', 'fully_autonomous'],
		archived: ['paused', 'archived'],
	},
	event: {
		new: ['proposed'],
		in_progress: ['planned', 'in_production', 'live'],
		done: ['published', 'wrapped_up'],
		archived: ['archived'],
	},
	content: {
		new: ['proposed'],
		in_progress: ['in_progress', 'approved'],
		needs_you: ['in_review'],
		done: ['published', 'live'],
		archived: ['archived'],
	},
	company: {
		new: ['prospect'],
		in_progress: ['icp_match', 'engaged', 'customer'],
		archived: ['churned', 'not_a_fit'],
	},
	contact: {
		new: ['new_lead'],
		in_progress: [
			'qualified',
			'connection_requested',
			'messaged',
			'in_conversation',
			'meeting_booked',
			'follow_up_later',
		],
		needs_you: ['offer_pending'],
		done: ['converted'],
		archived: ['rejected', 'not_interested'],
	},
	meeting: {
		new: ['scheduled'],
		in_progress: ['happened'],
		done: ['processed'],
		archived: ['cancelled', 'archived'],
	},
	knowledge: {
		new: ['draft'],
		done: ['validated'],
		archived: ['deprecated'],
	},
	chat: {
		archived: ['archived'],
		new: ['unread'],
		done: ['read'],
	},
	agent: {
		in_progress: ['running', 'idle'],
		archived: ['paused'],
		needs_you: ['failed'],
	},
	automation: {
		in_progress: ['on'],
		archived: ['off'],
	},
}

/** Flattened once: type to (status to group). */
const GROUP_BY_TYPE_AND_STATUS: Map<string, Map<string, StatusGroupKey>> = new Map(
	Object.entries(GROUP_STATUSES_BY_TYPE).map(([type, groups]) => {
		const byStatus = new Map<string, StatusGroupKey>()
		for (const key of STATUS_GROUP_KEYS) {
			for (const status of groups[key] ?? []) byStatus.set(status, key)
		}
		return [type, byStatus]
	}),
)

/**
 * Fallback rules for a status the table does not list, in order, first match
 * wins. They run on the lower-cased status with underscores read as spaces.
 * Taken verbatim from the design reference's normStatus.
 */
const STATUS_TEXT_RULES: ReadonlyArray<{ group: StatusGroupKey; test: (s: string) => boolean }> = [
	{
		group: 'needs_you',
		test: (s) => /await|needs you|decision|waiting|blocked|pending|at risk|review/.test(s),
	},
	{ group: 'archived', test: (s) => /archiv|dropp|churn|paus|^off$|cancel/.test(s) },
	{ group: 'done', test: (s) => /done|ship|publish|complet|resolv|clos|^read$|finish/.test(s) },
	{ group: 'new', test: (s) => /^new|draft|propos|unread|backlog/.test(s) },
]

function groupFromStatusText(status: string): StatusGroupKey {
	const text = status.toLowerCase().replace(/_/g, ' ').trim()
	return STATUS_TEXT_RULES.find((rule) => rule.test(text))?.group ?? 'in_progress'
}

/**
 * Maps a row's type and raw status to its status group. Unknown types, custom
 * statuses and a missing status all land on a group; nothing throws.
 */
export function getStatusGroup(
	type: string | null | undefined,
	status: string | null | undefined,
): StatusGroupKey {
	const raw = (status ?? '').trim()
	const known = GROUP_BY_TYPE_AND_STATUS.get((type ?? '').trim().toLowerCase())
	const fromTable = known?.get(raw.toLowerCase().replace(/\s+/g, '_'))
	return fromTable ?? groupFromStatusText(raw)
}
