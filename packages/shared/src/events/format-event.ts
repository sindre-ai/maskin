import {
	type FieldChange,
	OBJECT_DIFF_FIELDS,
	findChange,
	getChangesFromEventData,
} from './changes'

export interface ActorRef {
	id: string
	name: string
}

export interface EventLike {
	action: string
	entityType: string
	data: unknown
}

const OBJECT_ENTITY_TYPES = new Set(['bet', 'task', 'insight'])

export interface FormatContext {
	actorsById?: ReadonlyMap<string, ActorRef>
}

export function formatEventDescription(event: EventLike, ctx?: FormatContext): string {
	const { action, entityType } = event

	switch (action) {
		case 'created':
			if (entityType === 'bet') return 'proposed bet'
			return `created ${entityType}`
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
		case 'verified':
			return `verified ${entityType}`
		case 'unverified':
			return `unverified ${entityType}`
		case 'knowledge_write_undone':
			return 'undid a Knowledge Author write'
		case 'updated':
		case 'status_changed':
			if (OBJECT_ENTITY_TYPES.has(entityType)) {
				const detail = formatObjectUpdate(event, ctx)
				if (detail) return detail
			}
			return `updated ${entityType}`
		default:
			return `${action.replace(/_/g, ' ')} ${entityType}`
	}
}

export function isErrorEvent(event: EventLike): boolean {
	return event.action.includes('failed') || event.action.includes('timeout')
}

/**
 * Compact phrasing for a `status_changed` event when rendered directly under
 * its own phase divider — the divider already names the new status visually,
 * so the row only needs to indicate the actor moved here.
 */
export function formatStatusTransitionShort(event: EventLike): string {
	const changes = getChangesFromEventData(event.data, OBJECT_DIFF_FIELDS)
	const next = findChange(changes, 'status')?.new
	return `set the status to ${prettyStatus(next)}`
}

function formatObjectUpdate(event: EventLike, ctx?: FormatContext): string | null {
	const changes = getChangesFromEventData(event.data, OBJECT_DIFF_FIELDS)
	if (!changes || changes.length === 0) return null

	const clauses: string[] = []

	// Iterate the canonical field order so clauses are always {status, driver,
	// title, content, metadata, …} regardless of how the emitter ordered them.
	for (const field of OBJECT_DIFF_FIELDS) {
		const change = changes.find((c) => c.field === field)
		if (!change) continue
		switch (change.field) {
			case 'status':
				clauses.push(
					`changed status from ${prettyStatus(change.old)} to ${prettyStatus(change.new)}`,
				)
				break
			case 'driver':
				clauses.push(
					`changed driver from ${driverLabel(change.old, ctx)} to ${driverLabel(change.new, ctx)}`,
				)
				break
			case 'title':
				clauses.push(titleClause(change.old, change.new))
				break
			case 'content':
				clauses.push('updated content')
				break
			case 'metadata':
				clauses.push(...metadataClauses(change.old, change.new))
				break
		}
	}

	if (clauses.length === 0) return null
	return joinClauses(clauses)
}

function joinClauses(clauses: string[]): string {
	if (clauses.length === 1) return clauses[0] ?? ''
	if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`
	const last = clauses[clauses.length - 1] ?? ''
	return `${clauses.slice(0, -1).join(', ')}, and ${last}`
}

function prettyStatus(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0) return 'none'
	return value
		.replace(/_/g, ' ')
		.split(' ')
		.map((w) => {
			const first = w[0]
			return first === undefined ? w : first.toUpperCase() + w.slice(1)
		})
		.join(' ')
}

function driverLabel(value: unknown, ctx?: FormatContext): string {
	if (value == null || value === '') return 'no one'
	if (typeof value !== 'string') return 'unknown'
	const actor = ctx?.actorsById?.get(value)
	return actor?.name ?? 'unknown'
}

function titleClause(prev: unknown, next: unknown): string {
	const prevStr = typeof prev === 'string' ? prev : ''
	const nextStr = typeof next === 'string' ? next : ''
	if (prevStr === '' && nextStr !== '') return `set title to "${nextStr}"`
	if (prevStr !== '' && nextStr === '') return 'cleared title'
	return `changed title from "${prevStr}" to "${nextStr}"`
}

function metadataClauses(prev: unknown, next: unknown): string[] {
	const prevObj = isObject(prev) ? prev : {}
	const nextObj = isObject(next) ? next : {}
	const keys = new Set<string>([...Object.keys(prevObj), ...Object.keys(nextObj)])
	const changedKeys: string[] = []
	for (const key of keys) {
		if (!shallowEqual(prevObj[key], nextObj[key])) changedKeys.push(key)
	}
	if (changedKeys.length === 0) return []
	if (changedKeys.length > 3) return [`updated ${changedKeys.length} custom fields`]
	return changedKeys.map((k) => `updated custom field: ${k}`)
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shallowEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (a == null && b == null) return true
	if (typeof a !== typeof b) return false
	if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
		return JSON.stringify(a) === JSON.stringify(b)
	}
	return false
}

// Re-export FieldChange for consumers that read event data shape-agnostically.
export type { FieldChange }
