import type { EventResponse, ObjectResponse } from '@/lib/api'
import { OBJECT_DIFF_FIELDS, findChange, getChangesFromEventData } from '@maskin/shared'

export interface TimelinePhase {
	status: string
	startedAt: string | null
	events: EventResponse[]
}

function getStatusFromEvent(event: EventResponse, side: 'old' | 'new'): string | null {
	const changes = getChangesFromEventData(event.data, OBJECT_DIFF_FIELDS)
	const statusChange = findChange(changes, 'status')
	const value = statusChange?.[side]
	return typeof value === 'string' ? value : null
}

/**
 * Walks events in chronological order and groups them into phases keyed by the
 * status the object was in at the time of each event. Each `status_changed`
 * event opens a new phase and becomes the first row under it.
 */
export function buildPhases(
	events: EventResponse[],
	object: Pick<ObjectResponse, 'status' | 'createdAt'>,
): TimelinePhase[] {
	const firstChange = events.find((e) => e.action === 'status_changed')
	const initialStatus = firstChange
		? (getStatusFromEvent(firstChange, 'old') ?? object.status)
		: object.status

	const phases: TimelinePhase[] = [
		{ status: initialStatus, startedAt: object.createdAt, events: [] },
	]

	for (const event of events) {
		if (event.action === 'status_changed') {
			const newStatus = getStatusFromEvent(event, 'new') ?? object.status
			phases.push({ status: newStatus, startedAt: event.createdAt, events: [event] })
		} else {
			phases[phases.length - 1].events.push(event)
		}
	}

	return phases
}
