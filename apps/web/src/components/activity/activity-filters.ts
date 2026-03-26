import type { EventResponse } from '@/lib/api'

export type CategoryFilter = 'decision' | 'finding' | 'input' | 'agent' | 'human' | 'error'

export const FILTER_TABS = [
	{ label: 'All', value: undefined },
	{ label: 'Decision', value: 'decision' as const },
	{ label: 'Finding', value: 'finding' as const },
	{ label: 'Input', value: 'input' as const },
	{ label: 'Agent', value: 'agent' as const },
	{ label: 'Human', value: 'human' as const },
	{ label: 'Error', value: 'error' as const },
]

export function matchesFilter(
	event: EventResponse,
	filter: CategoryFilter,
	actorTypeMap: Map<string, string>,
): boolean {
	switch (filter) {
		case 'decision':
			return (
				event.entityType === 'bet' ||
				(event.entityType === 'notification' &&
					(event.data as Record<string, unknown>)?.type === 'needs_input')
			)
		case 'finding':
			return event.entityType === 'insight'
		case 'input':
			return event.entityType === 'notification'
		case 'agent':
			return actorTypeMap.get(event.actorId) === 'agent'
		case 'human':
			return actorTypeMap.get(event.actorId) === 'human'
		case 'error':
			return event.action.includes('failed') || event.action.includes('timeout')
	}
}
