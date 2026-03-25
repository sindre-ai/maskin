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
	blocked: { bg: 'bg-status-blocked-bg', text: 'text-status-blocked-text' },
	failed: { bg: 'bg-status-failed-bg', text: 'text-status-failed-text' },
	paused: { bg: 'bg-status-paused-bg', text: 'text-status-paused-text' },
	discarded: { bg: 'bg-status-discarded-bg', text: 'text-status-discarded-text' },
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

export const API_BASE = '/api'
