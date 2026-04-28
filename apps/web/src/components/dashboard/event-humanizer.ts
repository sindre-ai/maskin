import type { ActorListItem, EventResponse, ObjectResponse } from '@/lib/api'

/**
 * Pure transform from raw events into agent-voice captions for the live feed.
 * Lives next to `live-feed-captions.tsx` so other surfaces (agent page session
 * list, session modal) can later import and reuse it.
 *
 * The output is intentionally a structured array of caption parts rather than
 * a pre-rendered string — this lets the component render object references
 * as `<Link>`s and badges as styled pills without re-parsing the sentence.
 *
 * Adjacent micro-actions from the same actor with the same action+entityType
 * are collapsed into a single grouped caption ("I created 3 tasks") so the
 * feed reads like a story instead of a log.
 */

export type ActorLookup = (id: string | null) => ActorListItem | undefined
export type ObjectLookup = (id: string | null) => ObjectResponse | undefined

export type CaptionPart =
	| { kind: 'text'; text: string }
	| { kind: 'object'; objectId: string; objectType: string; title: string }
	| { kind: 'badge'; label: string; tone: 'status' | 'type' }

export interface Caption {
	id: string
	actorId: string | null
	actorName: string
	actorType: 'agent' | 'human'
	parts: CaptionPart[]
	timestamp: string | null
	isError: boolean
	groupedCount: number
}

interface NormalizedEvent {
	event: EventResponse
	objectTitle: string | null
	previousStatus: string | null
	newStatus: string | null
	groupKey: string
}

const OBJECT_ENTITY_TYPES = new Set(['bet', 'task', 'insight'])

function getEntityTitle(event: EventResponse, objectLookup: ObjectLookup): string | null {
	const data = event.data
	if (data) {
		if (typeof data.title === 'string') return data.title
		const updated = data.updated
		if (updated && typeof updated === 'object' && 'title' in updated) {
			const title = (updated as Record<string, unknown>).title
			if (typeof title === 'string') return title
		}
		const previous = data.previous
		if (previous && typeof previous === 'object' && 'title' in previous) {
			const title = (previous as Record<string, unknown>).title
			if (typeof title === 'string') return title
		}
	}
	return objectLookup(event.entityId)?.title ?? null
}

function getStatusFromData(
	source: unknown,
	field: 'status' | 'previous' | 'updated' = 'status',
): string | null {
	if (!source || typeof source !== 'object') return null
	const value = (source as Record<string, unknown>)[field]
	return typeof value === 'string' ? value : null
}

function getTransition(event: EventResponse): {
	previous: string | null
	next: string | null
} {
	const data = event.data
	if (!data) return { previous: null, next: null }
	const previous = getStatusFromData(data.previous, 'status')
	const next = getStatusFromData(data.updated, 'status')
	return { previous, next }
}

function normalize(event: EventResponse, objectLookup: ObjectLookup): NormalizedEvent {
	const objectTitle = getEntityTitle(event, objectLookup)
	const { previous, next } = getTransition(event)
	// Group adjacent events that should collapse together. Status transitions
	// only collapse when they end at the same status, so "shipped 3 tasks" is
	// safe but a mix of 'in_progress' + 'done' stays expanded.
	const statusSuffix = event.action === 'status_changed' ? `:${next ?? ''}` : ''
	const groupKey = `${event.actorId}|${event.action}|${event.entityType}${statusSuffix}`
	return { event, objectTitle, previousStatus: previous, newStatus: next, groupKey }
}

interface VerbPhrase {
	prefix: string
	suffix?: string
	preposition?: string
	pluralNoun?: string
	statusBadge?: string
	transitive: boolean
}

function statusVerb(newStatus: string | null): VerbPhrase | null {
	if (!newStatus) return null
	switch (newStatus) {
		case 'in_progress':
			return { prefix: "I'm working on", transitive: true }
		case 'in_review':
			return { prefix: 'I sent', suffix: 'for review', transitive: true }
		case 'done':
			return { prefix: 'I shipped', transitive: true }
		case 'blocked':
			return { prefix: 'I marked', suffix: 'blocked', transitive: true }
		case 'cancelled':
			return { prefix: 'I cancelled', transitive: true }
		case 'active':
			return { prefix: 'I activated', transitive: true }
		case 'todo':
			return { prefix: 'I queued', transitive: true }
		default:
			return null
	}
}

function buildVerbPhrase(event: NormalizedEvent, isAgent: boolean): VerbPhrase {
	const { event: raw, newStatus } = event
	const { action, entityType } = raw

	if (action === 'created') {
		if (entityType === 'bet') {
			return { prefix: isAgent ? 'I proposed' : 'proposed', transitive: true, pluralNoun: 'bets' }
		}
		return {
			prefix: isAgent ? 'I created' : 'created',
			transitive: true,
			pluralNoun: `${entityType}s`,
		}
	}

	if (action === 'status_changed') {
		const verb = statusVerb(newStatus)
		if (verb) {
			if (!isAgent) {
				return { ...verb, prefix: verb.prefix.replace(/^I'm /, '').replace(/^I /, '') }
			}
			return { ...verb, statusBadge: newStatus ?? undefined }
		}
		return {
			prefix: isAgent ? 'I moved' : 'moved',
			transitive: true,
			suffix: newStatus ? `to ${newStatus.replace(/_/g, ' ')}` : undefined,
			statusBadge: newStatus ?? undefined,
		}
	}

	if (action === 'updated') {
		return { prefix: isAgent ? 'I updated' : 'updated', transitive: true }
	}

	if (action === 'deleted') {
		return { prefix: isAgent ? 'I removed' : 'removed', transitive: true }
	}

	if (action === 'session_created') {
		return { prefix: isAgent ? 'I started a new session' : 'started a session', transitive: false }
	}
	if (action === 'session_running') {
		return { prefix: isAgent ? "I'm running" : 'is running', transitive: false }
	}
	if (action === 'session_completed') {
		return { prefix: isAgent ? 'I finished my session' : 'finished a session', transitive: false }
	}
	if (action === 'session_failed') {
		return { prefix: isAgent ? 'My session failed' : 'session failed', transitive: false }
	}
	if (action === 'session_timeout') {
		return { prefix: isAgent ? 'My session timed out' : 'session timed out', transitive: false }
	}
	if (action === 'session_paused') {
		return { prefix: isAgent ? 'I paused my session' : 'paused a session', transitive: false }
	}
	if (action === 'trigger_fired') {
		return { prefix: isAgent ? 'I fired a trigger' : 'fired a trigger', transitive: false }
	}

	// Fallback for unknown actions — readable but not pretending to be voicey.
	const verb = action.replace(/_/g, ' ')
	return { prefix: isAgent ? `I ${verb}` : verb, transitive: true }
}

function pushObjectOrTitle(
	parts: CaptionPart[],
	event: EventResponse,
	objectTitle: string | null,
): void {
	if (objectTitle) {
		if (OBJECT_ENTITY_TYPES.has(event.entityType)) {
			parts.push({
				kind: 'object',
				objectId: event.entityId,
				objectType: event.entityType,
				title: objectTitle,
			})
		} else {
			parts.push({ kind: 'text', text: objectTitle })
		}
	} else {
		// Missing-object fallback — degrade gracefully rather than omitting the
		// noun entirely, so the sentence still reads as English.
		parts.push({ kind: 'text', text: `a ${event.entityType}` })
	}
}

function buildPartsForSingle(event: NormalizedEvent, verb: VerbPhrase): CaptionPart[] {
	const parts: CaptionPart[] = []
	parts.push({ kind: 'text', text: verb.prefix })
	if (verb.transitive) {
		pushObjectOrTitle(parts, event.event, event.objectTitle)
	}
	if (verb.suffix) parts.push({ kind: 'text', text: verb.suffix })
	if (verb.statusBadge) {
		parts.push({ kind: 'badge', label: verb.statusBadge, tone: 'status' })
	}
	return parts
}

function buildPartsForGroup(
	count: number,
	event: NormalizedEvent,
	verb: VerbPhrase,
): CaptionPart[] {
	const parts: CaptionPart[] = []
	parts.push({ kind: 'text', text: verb.prefix })
	if (verb.transitive) {
		const noun = verb.pluralNoun ?? `${event.event.entityType}s`
		parts.push({ kind: 'text', text: `${count} ${noun}` })
	} else {
		parts.push({ kind: 'text', text: `(${count}×)` })
	}
	if (verb.suffix) parts.push({ kind: 'text', text: verb.suffix })
	if (verb.statusBadge) {
		parts.push({ kind: 'badge', label: verb.statusBadge, tone: 'status' })
	}
	return parts
}

function isErrorAction(action: string): boolean {
	return action.includes('failed') || action.includes('timeout')
}

/**
 * Convert an event list into agent-voice captions. Events are expected to be
 * pre-sorted by `createdAt` descending (the `useEvents` hook returns them
 * that way); we walk that order and collapse adjacent micro-actions sharing
 * the same `(actorId, action, entityType, [newStatus])` key.
 *
 * Missing actors/objects degrade gracefully:
 *   - unknown actor → "Someone" (third-person, never first-person)
 *   - unknown object → "a {entityType}"
 */
export function humanizeEvents(
	events: EventResponse[],
	actorLookup: ActorLookup,
	objectLookup: ObjectLookup,
): Caption[] {
	const captions: Caption[] = []

	let i = 0
	while (i < events.length) {
		const head = normalize(events[i], objectLookup)
		const headActor = actorLookup(head.event.actorId)

		let j = i + 1
		while (j < events.length) {
			const candidate = normalize(events[j], objectLookup)
			if (candidate.groupKey !== head.groupKey) break
			j++
		}

		const groupSize = j - i
		const isAgent = headActor?.type === 'agent'
		// Without a known actor we fall back to a neutral third-person voice — we
		// can't honestly say "I shipped X" if we don't know who did it.
		const displayName = headActor?.name ?? 'Someone'
		const actorType: 'agent' | 'human' = isAgent ? 'agent' : 'human'
		const knownActor = !!headActor
		const verb = buildVerbPhrase(head, isAgent && knownActor)

		const parts =
			groupSize > 1 ? buildPartsForGroup(groupSize, head, verb) : buildPartsForSingle(head, verb)

		captions.push({
			id: `${head.event.id}-${groupSize}`,
			actorId: head.event.actorId,
			actorName: displayName,
			actorType,
			parts,
			timestamp: head.event.createdAt,
			isError: isErrorAction(head.event.action),
			groupedCount: groupSize,
		})

		i = j
	}

	return captions
}
