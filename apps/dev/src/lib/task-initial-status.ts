import { capturePosthogEvent } from './analytics/posthog'
import { createApiError } from './errors'

/**
 * Built-in task statuses that mean work already started or finished. Only the
 * Drive-the-task trigger on a move to `todo` dispatches a driver, so a task
 * created in any of these sits idle with nobody working it. Deny-list on
 * purpose: task statuses are workspace-configurable, so custom initial
 * statuses (e.g. `awaiting_legal`) stay allowed.
 */
const REJECTED_TASK_INITIAL_STATUSES: ReadonlySet<string> = new Set([
	'in_progress',
	'in_review',
	'validated',
	'done',
	'discarded',
])

/**
 * Shared by POST /api/objects and POST /api/graph. Returns a 400 error body
 * when a task is being created at a status that skips the dispatch trigger,
 * and fires one PostHog event per rejection (attempted status and actor id
 * only, no title or body). Returns null when the creation is allowed.
 */
export function checkTaskInitialStatus(params: {
	type: string
	status: string
	actorId: string
	field: string
}) {
	if (params.type !== 'task' || !REJECTED_TASK_INITIAL_STATUSES.has(params.status)) return null

	capturePosthogEvent('task_created_invalid_initial_status', params.actorId, {
		attempted_status: params.status,
		actor_id: params.actorId,
	}).catch(() => {})

	return createApiError(
		'BAD_REQUEST',
		`Cannot create a task with status '${params.status}'. Create it with status 'todo' or 'backlog', then move it later.`,
		[
			{
				field: params.field,
				message: `'${params.status}' is not allowed as the initial status of a task`,
				expected: `'todo' | 'backlog'`,
				received: `'${params.status}'`,
			},
		],
		"Create the task with status 'todo' (starts the Drive the task trigger) or 'backlog', then update its status once work begins.",
	)
}
