import { type ObjectResponse, api } from '@/lib/api'
import type { ActorListItem } from '@maskin/shared'

// Named lists a view may ask the file viewer for (see the bridge section in
// mini-app.ts). A view names a list in its maskin-sources block:
//   {"opps": {"list": "opportunities", "params": {"status": ["opportunity"]}}}
// The file asks by name; the app decides what the name means and what leaves.
// Both the list names and their params are fixed here. Anything else is refused,
// not guessed at. Rows are fetched with the viewer's own session through the
// existing object list route, then projected to the contract fields before they
// are handed to the frame: the route returns whole rows (content, all metadata),
// and none of that may reach the view. People rows carry prospects' emails, so
// their contract is the narrowest set the People template needs.

/** What a view is told when it asks for a list, param or value the app does not offer. */
export const LIST_REFUSED_MESSAGE = "This view asks for data the app doesn't offer"

export const MAX_LIST_ROWS = 200
export const MAX_UPDATED_WITHIN_DAYS = 30

// The object list route returns at most this many rows per call.
const PAGE_SIZE = 100
const DAY_MS = 24 * 60 * 60 * 1000

const BET_STATUSES = ['opportunity', 'define', 'active', 'paused'] as const

// The People pipeline, in the order the workspace schema lists them.
const CONTACT_STATUSES = [
	'new_lead',
	'qualified',
	'connection_requested',
	'messaged',
	'in_conversation',
	'meeting_booked',
	'offer_pending',
	'converted',
	'rejected',
	'not_interested',
	'follow_up_later',
] as const

export interface OpportunitiesListSource {
	list: 'opportunities'
	statuses: string[]
	maxRows: number
	updatedWithinDays: number | null
}

export interface PeopleListSource {
	list: 'people'
	statuses: string[]
	maxRows: number
	updatedWithinDays: number | null
	/** true: only people with no driver; false: only people with one; null: both. Applied after the fetch. */
	ownerEmpty: boolean | null
}

export type ListSource = OpportunitiesListSource | PeopleListSource

/** A declared list source, or `null` when the declaration asks for something the app does not offer. */
export type ListSourceEntry = ListSource | null

export interface OpportunityRow {
	id: string
	title: string | null
	status: string
	priority: string | null
	size: string | null
	size_is_guess: boolean | null
	evidence_strength: string | null
	moves_the_bar: string | null
	problem_space: string | null
	updatedAt: string | null
}

export interface PersonRow {
	id: string
	title: string | null
	status: string
	/** The driver's actor id, or null when nobody drives the person. */
	driver: string | null
	/** The driver's name from one actors call, or null when there is no driver or the name is unknown. */
	driver_name: string | null
	email: string | null
	linkedin_url: string | null
	location: string | null
	summary: string | null
	next_step: string | null
	next_step_date: string | null
	updatedAt: string | null
}

export type ListRow = OpportunityRow | PersonRow

/** The answer a view gets for a list source. `rows` is null until the first Refresh click. */
export type ListAnswer = { rows: null; notRefreshed: true } | { rows: ListRow[]; fetchedAt: number }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** True for a manifest entry that names a list, as opposed to a count query. */
export function isListDeclaration(value: unknown): boolean {
	return isPlainObject(value) && Object.hasOwn(value, 'list')
}

export function parseListSource(value: unknown): ListSourceEntry {
	if (!isPlainObject(value)) return null
	for (const key of Object.keys(value)) if (key !== 'list' && key !== 'params') return null
	const list = value.list
	if (list !== 'opportunities' && list !== 'people') return null
	const params = value.params === undefined ? {} : value.params
	if (!isPlainObject(params)) return null
	const allowed = ['status', 'max_rows', 'updated_within_days']
	if (list === 'people') allowed.push('owner_empty')
	for (const key of Object.keys(params)) if (!allowed.includes(key)) return null

	let statuses: string[] = list === 'people' ? [] : ['opportunity']
	if (params.status !== undefined) {
		const status = params.status
		const offered: readonly unknown[] = list === 'people' ? CONTACT_STATUSES : BET_STATUSES
		if (!Array.isArray(status) || status.length === 0) return null
		if (!status.every((s) => offered.includes(s))) return null
		statuses = [...new Set(status as string[])]
	}

	let maxRows = MAX_LIST_ROWS
	if (params.max_rows !== undefined) {
		const n = params.max_rows
		if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_LIST_ROWS) return null
		maxRows = n
	}

	let updatedWithinDays: number | null = null
	if (params.updated_within_days !== undefined) {
		const n = params.updated_within_days
		if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_UPDATED_WITHIN_DAYS) {
			return null
		}
		updatedWithinDays = n
	}

	if (list === 'opportunities') return { list, statuses, maxRows, updatedWithinDays }

	let ownerEmpty: boolean | null = null
	if (params.owner_empty !== undefined) {
		if (typeof params.owner_empty !== 'boolean') return null
		ownerEmpty = params.owner_empty
	}
	return { list, statuses, maxRows, updatedWithinDays, ownerEmpty }
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/**
 * Cuts an object down to the contract fields. Built field by field on purpose: a
 * spread or a delete-list would let a new column or metadata key reach the frame.
 */
export function projectOpportunity(object: ObjectResponse): OpportunityRow {
	const meta: Record<string, unknown> = object.metadata ?? {}
	return {
		id: object.id,
		title: object.title,
		status: object.status,
		priority: str(meta.priority),
		size: str(meta.size),
		size_is_guess: typeof meta.size_is_guess === 'boolean' ? meta.size_is_guess : null,
		evidence_strength: str(meta.evidence_strength),
		moves_the_bar: str(meta.moves_the_bar),
		problem_space: str(meta.problem_space),
		updatedAt: object.updatedAt,
	}
}

export function projectPerson(
	object: ObjectResponse,
	driverNames: ReadonlyMap<string, string> = new Map(),
): PersonRow {
	const meta: Record<string, unknown> = object.metadata ?? {}
	return {
		id: object.id,
		title: object.title,
		status: object.status,
		driver: object.driver,
		driver_name: (object.driver && driverNames.get(object.driver)) || null,
		email: str(meta.email),
		linkedin_url: str(meta.linkedin_url),
		location: str(meta.location),
		summary: str(meta.summary),
		next_step: str(meta.next_step),
		next_step_date: str(meta.next_step_date),
		updatedAt: object.updatedAt,
	}
}

// Up to 100 rows is one call; more is a second call pinned to the first call's moment
// with snapshot_at, so a row written between the two cannot shift the pages.
async function fetchObjects(
	workspaceId: string,
	type: 'bet' | 'contact',
	source: ListSource,
	now: number,
): Promise<ObjectResponse[]> {
	const snapshotAt = new Date(now).toISOString()
	const objects: ObjectResponse[] = []
	while (objects.length < source.maxRows) {
		const limit = Math.min(PAGE_SIZE, source.maxRows - objects.length)
		const params: Record<string, string> = {
			type,
			limit: String(limit),
			offset: String(objects.length),
			snapshot_at: snapshotAt,
		}
		if (source.statuses.length > 0) params.status = source.statuses.join(',')
		if (source.updatedWithinDays !== null) {
			params.updated_after = new Date(now - source.updatedWithinDays * DAY_MS).toISOString()
		}
		const page = await api.objects.list(workspaceId, params)
		objects.push(...page)
		if (page.length < limit) break
	}
	return objects
}

/** Runs a list source as the viewer and projects every row to the contract fields. */
export async function fetchListRows(
	workspaceId: string,
	source: ListSource,
	now: number = Date.now(),
): Promise<ListRow[]> {
	if (source.list === 'opportunities') {
		return (await fetchObjects(workspaceId, 'bet', source, now)).map(projectOpportunity)
	}
	const people = (await fetchObjects(workspaceId, 'contact', source, now)).filter(
		(p) => source.ownerEmpty === null || (p.driver === null) === source.ownerEmpty,
	)
	// One actors call for every driver name, and only when some row has a driver.
	const driverNames = new Map<string, string>()
	if (people.some((p) => p.driver !== null)) {
		const actors: ActorListItem[] = await api.actors.list(workspaceId)
		for (const actor of actors) driverNames.set(actor.id, actor.name)
	}
	return people.map((p) => projectPerson(p, driverNames))
}
