import type { EventResponse, ObjectResponse } from '@/lib/api'

export interface TimelinePhase {
	status: string
	startedAt: string | null
	events: EventResponse[]
}

function getStatusFromSnapshot(snapshot: unknown, key: 'previous' | 'updated'): string | null {
	if (typeof snapshot !== 'object' || snapshot === null) return null
	const inner = (snapshot as Record<string, unknown>)[key]
	if (typeof inner !== 'object' || inner === null) return null
	const status = (inner as Record<string, unknown>).status
	return typeof status === 'string' ? status : null
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
		? (getStatusFromSnapshot(firstChange.data, 'previous') ?? object.status)
		: object.status

	const phases: TimelinePhase[] = [
		{ status: initialStatus, startedAt: object.createdAt, events: [] },
	]

	for (const event of events) {
		if (event.action === 'status_changed') {
			const newStatus = getStatusFromSnapshot(event.data, 'updated') ?? object.status
			phases.push({ status: newStatus, startedAt: event.createdAt, events: [event] })
		} else {
			phases[phases.length - 1].events.push(event)
		}
	}

	return phases
}
