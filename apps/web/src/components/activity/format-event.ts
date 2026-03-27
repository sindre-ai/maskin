import type { EventResponse } from '@/lib/api'

export function formatEventDescription(event: EventResponse): string {
	const { action, entityType } = event

	switch (action) {
		case 'created':
			if (entityType === 'bet') return 'proposed bet'
			return `created ${entityType}`
		case 'updated':
			return `updated ${entityType}`
		case 'deleted':
			return `deleted ${entityType}`
		case 'session_created':
			return 'started session'
		case 'session_running':
			return 'is running session'
		case 'session_completed':
			return 'completed session'
		case 'session_failed':
			return 'session failed'
		case 'session_timeout':
			return 'session timed out'
		case 'session_paused':
			return 'paused session'
		case 'trigger_fired':
			return 'fired trigger'
		default:
			return `${action.replace(/_/g, ' ')} ${entityType}`
	}
}

export function isErrorEvent(event: EventResponse): boolean {
	return event.action.includes('failed') || event.action.includes('timeout')
}
