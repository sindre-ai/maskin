import type { ActorListItem, ObjectResponse } from '@/lib/api'

/**
 * URL-state filter shape for /work. Every field is optional; an undefined value
 * means "no filter" so the URL stays short. Multi-filter combos AND together
 * (matched independently and intersected) — see {@link matchesFilters}.
 */
export interface WorkBoardFilters {
	/** A single bet ID. When set, only that bet's swimlane renders. */
	bet?: string
	/**
	 * Either one of the keyword groups (`mine` / `humans` / `agents`) or a
	 * specific actor ID. Matching is against `task.owner` only — that's the
	 * single-assignee model on the schema today; multi-assignee can extend
	 * this without changing the URL contract.
	 */
	assignee?: string
	/** `blocked`, `active`, or `all`. Undefined behaves like `all`. */
	status?: 'blocked' | 'active' | 'all'
}

export type AssigneeKeyword = 'mine' | 'humans' | 'agents'

const ASSIGNEE_KEYWORDS: AssigneeKeyword[] = ['mine', 'humans', 'agents']

export function isAssigneeKeyword(value: string): value is AssigneeKeyword {
	return (ASSIGNEE_KEYWORDS as string[]).includes(value)
}

/** Returns true when the filters object has at least one active filter. */
export function hasActiveFilters(filters: WorkBoardFilters): boolean {
	if (filters.bet) return true
	if (filters.assignee) return true
	if (filters.status && filters.status !== 'all') return true
	return false
}

/**
 * Decides whether a task is included for the given filters. The `bet` filter
 * is applied at the swimlane level (not here) — this only handles assignee
 * and status, which apply per-task within a lane.
 */
export function matchesFilters(
	task: ObjectResponse,
	filters: WorkBoardFilters,
	context: {
		currentActorId: string | null
		actorTypeById: Map<string, string>
	},
): boolean {
	if (filters.assignee) {
		if (!matchesAssignee(task, filters.assignee, context)) return false
	}
	if (filters.status && filters.status !== 'all') {
		if (!matchesStatus(task, filters.status)) return false
	}
	return true
}

function matchesAssignee(
	task: ObjectResponse,
	assignee: string,
	context: { currentActorId: string | null; actorTypeById: Map<string, string> },
): boolean {
	const owner = task.owner
	if (!owner) return false
	if (assignee === 'mine') return owner === context.currentActorId
	if (assignee === 'humans') return context.actorTypeById.get(owner) === 'human'
	if (assignee === 'agents') return context.actorTypeById.get(owner) === 'agent'
	return owner === assignee
}

function matchesStatus(task: ObjectResponse, status: 'blocked' | 'active'): boolean {
	if (status === 'blocked') return task.status === 'blocked'
	// active = everything except `done`
	return task.status !== 'done'
}

export function actorTypeMap(actors: ActorListItem[] | undefined): Map<string, string> {
	const map = new Map<string, string>()
	if (!actors) return map
	for (const actor of actors) map.set(actor.id, actor.type)
	return map
}
