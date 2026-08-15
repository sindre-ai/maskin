export const statusColors: Record<string, { bg: string; text: string }> = {
	new: { bg: 'bg-status-new-bg', text: 'text-status-new-text' },
	todo: { bg: 'bg-status-todo-bg', text: 'text-status-todo-text' },
	processing: { bg: 'bg-status-processing-bg', text: 'text-status-processing-text' },
	in_progress: { bg: 'bg-status-in_progress-bg', text: 'text-status-in_progress-text' },
	active: { bg: 'bg-status-active-bg', text: 'text-status-active-text' },
	signal: { bg: 'bg-status-signal-bg', text: 'text-status-signal-text' },
	proposed: { bg: 'bg-status-proposed-bg', text: 'text-status-proposed-text' },
	clustered: { bg: 'bg-status-clustered-bg', text: 'text-status-clustered-text' },
	done: { bg: 'bg-status-done-bg', text: 'text-status-done-text' },
	completed: { bg: 'bg-status-completed-bg', text: 'text-status-completed-text' },
	succeeded: { bg: 'bg-status-succeeded-bg', text: 'text-status-succeeded-text' },
	queued: { bg: 'bg-status-processing-bg', text: 'text-status-processing-text' },
	blocked: { bg: 'bg-status-blocked-bg', text: 'text-status-blocked-text' },
	failed: { bg: 'bg-status-failed-bg', text: 'text-status-failed-text' },
	paused: { bg: 'bg-status-paused-bg', text: 'text-status-paused-text' },
	discarded: { bg: 'bg-status-discarded-bg', text: 'text-status-discarded-text' },
	qualified: { bg: 'bg-status-qualified-bg', text: 'text-status-qualified-text' },
	define: { bg: 'bg-status-define-bg', text: 'text-status-define-text' },
	live: { bg: 'bg-status-live-bg', text: 'text-status-live-text' },
	scored: { bg: 'bg-status-scored-bg', text: 'text-status-scored-text' },
	parked: { bg: 'bg-status-parked-bg', text: 'text-status-parked-text' },
	archived: { bg: 'bg-status-archived-bg', text: 'text-status-archived-text' },
	in_review: { bg: 'bg-status-in_review-bg', text: 'text-status-in_review-text' },
	validated: { bg: 'bg-status-validated-bg', text: 'text-status-validated-text' },
	holding: { bg: 'bg-status-holding-bg', text: 'text-status-holding-text' },
	'at-risk': { bg: 'bg-status-at_risk-bg', text: 'text-status-at_risk-text' },
	breached: { bg: 'bg-status-breached-bg', text: 'text-status-breached-text' },
	pending: { bg: 'bg-status-processing-bg', text: 'text-status-processing-text' },
	starting: { bg: 'bg-status-processing-bg', text: 'text-status-processing-text' },
	running: { bg: 'bg-status-active-bg', text: 'text-status-active-text' },
	snapshotting: { bg: 'bg-status-processing-bg', text: 'text-status-processing-text' },
	waiting_for_input: { bg: 'bg-status-blocked-bg', text: 'text-status-blocked-text' },
	timeout: { bg: 'bg-status-failed-bg', text: 'text-status-failed-text' },
}

export const typeIcons: Record<string, string> = {
	insight: '💡',
	bet: '🎯',
	task: '☐',
}

export const typeColors: Record<string, { bg: string; text: string }> = {
	insight: { bg: 'bg-type-insight-bg', text: 'text-type-insight-text' },
	bet: { bg: 'bg-type-bet-bg', text: 'text-type-bet-text' },
	task: { bg: 'bg-type-task-bg', text: 'text-type-task-text' },
}

/** Fallback for extension-defined types not in the hardcoded maps */
export const defaultTypeColor = { bg: 'bg-muted', text: 'text-muted-foreground' }
export const defaultStatusColor = { bg: 'bg-muted', text: 'text-muted-foreground' }

export function getTypeColor(type: string) {
	return typeColors[type] ?? defaultTypeColor
}

// Human-readable labels for the core object types — used by the search
// surfaces (command palette + /search) to render "Bet" instead of the raw
// `type` column value next to a result row.
export const TYPE_LABELS: Record<string, string> = {
	insight: 'Insight',
	bet: 'Bet',
	task: 'Task',
}

export function typeLabel(type: string): string {
	return TYPE_LABELS[type] ?? type
}

// Human-readable labels for the workflow statuses the /search view ships with —
// mirrors the Designer mockup's STATUS_LABEL map. Custom statuses configured in
// workspace settings render via `statusLabel`'s humanize fallback.
export const STATUS_LABELS: Record<string, string> = {
	active: 'Active',
	in_progress: 'In progress',
	todo: 'To do',
	define: 'Define',
	in_review: 'In review',
	done: 'Done',
	validated: 'Validated',
}

export function statusLabel(status: string): string {
	return STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
}

export function getStatusColor(status: string) {
	return statusColors[status] ?? defaultStatusColor
}

export const API_BASE = '/api'
