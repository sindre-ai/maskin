import { type ObjectResponse, api } from '@/lib/api'

// Named lists a view may ask the host for (see the bridge section in mini-app.ts).
// A view names a list in its maskin-sources block:
//   {"opps": {"list": "opportunities", "params": {"status": ["opportunity"]}}}
//   {"posts": {"list": "objects", "params": {"type": "content", "status": ["proposed"],
//     "where": {"platform": "linkedin"}, "sort": "scheduled_date", "order": "asc",
//     "fields": ["platform", "cluster"], "max_rows": 100}}}
// The file asks by name; the app decides what the name means and what leaves.
// Both the list names and their params are fixed here. Anything else is refused,
// not guessed at. Rows are fetched with the viewer's own session through the
// existing object list route, then projected to the contract fields before they
// are handed to the frame: the route returns whole rows (content, all metadata),
// and none of that may reach the view.

/** What a view is told when it asks for a list, param or value the app does not offer. */
export const LIST_REFUSED_MESSAGE = "This view asks for data the app doesn't offer"

export const MAX_LIST_ROWS = 200
export const MAX_UPDATED_WITHIN_DAYS = 30

// The object list route returns at most this many rows per call.
const PAGE_SIZE = 100
const DAY_MS = 24 * 60 * 60 * 1000

const BET_STATUSES = ['opportunity', 'define', 'active', 'paused'] as const

// The generic `objects` list. One page of the object list route, so the cap is the route's.
export const MAX_OBJECT_LIST_ROWS = PAGE_SIZE
const MAX_OBJECT_LIST_STATUSES = 10
const MAX_OBJECT_LIST_WHERE = 4
const MAX_OBJECT_LIST_FIELDS = 20
const MAX_WHERE_VALUE_LENGTH = 200
const TYPE_RE = /^[a-z][a-z_]{0,39}$/
const STATUS_RE = /^[a-z][a-z_]{0,39}$/

/**
 * The only metadata keys a view may name, to filter on, sort by or get back. Body text and
 * free-text notes (angle, editor_verdict, published_by) are not on it on purpose.
 */
export const LIST_METADATA_KEYS = [
	'priority',
	'size',
	'size_is_guess',
	'evidence_strength',
	'moves_the_bar',
	'problem_space',
	'cluster',
	'platform',
	'audience',
	'account',
	'content_type',
	'scheduled_date',
	'scheduled_for',
	'post_time',
	'published_at',
] as const

/**
 * The only fields a view may propose a change to, each with the shape its value must have.
 * A view may propose a field only if it also named it in a list's `fields`, so a view can
 * ask to change what it shows and nothing else.
 */
export const PROPOSABLE_FIELDS = ['scheduled_date', 'post_time'] as const
export type ProposableField = (typeof PROPOSABLE_FIELDS)[number]

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** The value to save for a proposed change, or null when the field or value is not one the app accepts. */
export function parseProposedValue(field: string, value: unknown): string | null {
	if (typeof value !== 'string') return null
	if (field === 'post_time') return TIME_RE.test(value) ? value : null
	if (field !== 'scheduled_date') return null
	const m = DATE_RE.exec(value)
	if (!m) return null
	const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
	// 2026-02-31 rolls over to March; a date that does not round-trip is not a date.
	return date.toISOString().slice(0, 10) === value ? value : null
}

/** The proposable fields a view named in its declared lists. */
export function declaredProposableFields(
	lists: ReadonlyMap<string, ListSourceEntry>,
): Set<ProposableField> {
	const declared = new Set<ProposableField>()
	for (const entry of lists.values()) {
		if (entry?.list !== 'objects') continue
		for (const field of entry.fields) {
			if ((PROPOSABLE_FIELDS as readonly string[]).includes(field)) {
				declared.add(field as ProposableField)
			}
		}
	}
	return declared
}

/** Columns a view may ask for besides the always-present id, title, status and url. */
const LIST_COLUMN_FIELDS = ['driver', 'createdAt', 'updatedAt'] as const
const LIST_SORT_COLUMNS = ['createdAt', 'updatedAt', 'title', 'status'] as const

const isMetadataKey = (key: unknown): key is string =>
	typeof key === 'string' && (LIST_METADATA_KEYS as readonly string[]).includes(key)

export interface OpportunitiesListSource {
	list: 'opportunities'
	statuses: string[]
	maxRows: number
	updatedWithinDays: number | null
}

/** Any object type, filtered on named metadata keys, with only the fields the view names. */
export interface ObjectsListSource {
	list: 'objects'
	type: string
	/** Empty means every status except archived (the route hides archived). */
	statuses: string[]
	/** Metadata key to the value it must equal. */
	where: Record<string, string>
	/** A sort column, or a metadata key from the allow-list. */
	sort: string
	order: 'asc' | 'desc'
	/** Columns and metadata keys sent back besides id, title, status and url. */
	fields: string[]
	maxRows: number
}

export type ListSource = OpportunitiesListSource | ObjectsListSource

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

export type ObjectRowValue = string | number | boolean | null

/** A row of an `objects` list: id, title, status and the app link, plus exactly the fields the view named. */
export interface ObjectRow {
	id: string
	title: string | null
	status: string
	/** Path of the object's page in the app. */
	url: string
	[field: string]: ObjectRowValue
}

export type ListRow = OpportunityRow | ObjectRow

/** The answer a view gets for a list source. `rows` is null until the first Refresh click. */
export type ListAnswer = { rows: null; notRefreshed: true } | { rows: ListRow[]; fetchedAt: number }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** True for a manifest entry that names a list, as opposed to a count query. */
export function isListDeclaration(value: unknown): boolean {
	return isPlainObject(value) && Object.hasOwn(value, 'list')
}

function parseObjectsListSource(params: Record<string, unknown>): ObjectsListSource | null {
	for (const key of Object.keys(params)) {
		if (!['type', 'status', 'where', 'sort', 'order', 'fields', 'max_rows'].includes(key)) {
			return null
		}
	}
	if (typeof params.type !== 'string' || !TYPE_RE.test(params.type)) return null

	let statuses: string[] = []
	if (params.status !== undefined) {
		const status = params.status
		if (!Array.isArray(status) || status.length === 0) return null
		if (!status.every((s) => typeof s === 'string' && STATUS_RE.test(s))) return null
		statuses = [...new Set(status as string[])]
		if (statuses.length > MAX_OBJECT_LIST_STATUSES) return null
	}

	const where: Record<string, string> = {}
	if (params.where !== undefined) {
		if (!isPlainObject(params.where)) return null
		const entries = Object.entries(params.where)
		if (entries.length > MAX_OBJECT_LIST_WHERE) return null
		for (const [key, wanted] of entries) {
			if (!isMetadataKey(key)) return null
			if (typeof wanted !== 'string' || wanted === '' || wanted.length > MAX_WHERE_VALUE_LENGTH) {
				return null
			}
			where[key] = wanted
		}
	}

	let sort = 'updatedAt'
	if (params.sort !== undefined) {
		const wanted = params.sort
		if (typeof wanted !== 'string') return null
		if (!(LIST_SORT_COLUMNS as readonly string[]).includes(wanted) && !isMetadataKey(wanted)) {
			return null
		}
		sort = wanted
	}

	let order: 'asc' | 'desc' = 'desc'
	if (params.order !== undefined) {
		if (params.order !== 'asc' && params.order !== 'desc') return null
		order = params.order
	}

	let fields: string[] = []
	if (params.fields !== undefined) {
		const named = params.fields
		if (!Array.isArray(named) || named.length > MAX_OBJECT_LIST_FIELDS) return null
		if (
			!named.every(
				(f) => (LIST_COLUMN_FIELDS as readonly unknown[]).includes(f) || isMetadataKey(f),
			)
		) {
			return null
		}
		fields = [...new Set(named as string[])]
	}

	let maxRows = MAX_OBJECT_LIST_ROWS
	if (params.max_rows !== undefined) {
		const n = params.max_rows
		if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_OBJECT_LIST_ROWS) {
			return null
		}
		maxRows = n
	}

	return { list: 'objects', type: params.type, statuses, where, sort, order, fields, maxRows }
}

export function parseListSource(value: unknown): ListSourceEntry {
	if (!isPlainObject(value)) return null
	for (const key of Object.keys(value)) if (key !== 'list' && key !== 'params') return null
	if (value.list !== 'opportunities' && value.list !== 'objects') return null
	const params = value.params === undefined ? {} : value.params
	if (!isPlainObject(params)) return null
	if (value.list === 'objects') return parseObjectsListSource(params)
	for (const key of Object.keys(params)) {
		if (key !== 'status' && key !== 'max_rows' && key !== 'updated_within_days') return null
	}

	let statuses: string[] = ['opportunity']
	if (params.status !== undefined) {
		const status = params.status
		if (!Array.isArray(status) || status.length === 0) return null
		if (!status.every((s) => (BET_STATUSES as readonly unknown[]).includes(s))) return null
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

	return { list: 'opportunities', statuses, maxRows, updatedWithinDays }
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

const scalar = (value: unknown): ObjectRowValue =>
	typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
		? value
		: null

/**
 * Cuts an object down to id, title, status, its link and exactly the fields the view
 * named (already checked against the allow-list by `parseListSource`). Built field by
 * field, and scalar values only, so no body text and no nested metadata can ride along.
 */
export function projectObjectRow(object: ObjectResponse, fields: readonly string[]): ObjectRow {
	const meta: Record<string, unknown> = object.metadata ?? {}
	const row: ObjectRow = {
		id: object.id,
		title: object.title,
		status: object.status,
		url: `/${object.workspaceId}/objects/${object.id}`,
	}
	for (const field of fields) {
		if (field === 'driver') row.driver = object.driver
		else if (field === 'createdAt') row.createdAt = object.createdAt
		else if (field === 'updatedAt') row.updatedAt = object.updatedAt
		else if (isMetadataKey(field)) row[field] = scalar(meta[field])
	}
	return row
}

/** One call to the object list route as the viewer; the route is the same one a count source's permissions run through. */
async function fetchObjectRows(
	workspaceId: string,
	source: ObjectsListSource,
): Promise<ObjectRow[]> {
	const params: Record<string, string> = {
		type: source.type,
		sort: LIST_SORT_COLUMNS.includes(source.sort as never)
			? source.sort
			: `metadata.${source.sort}`,
		order: source.order,
		limit: String(source.maxRows),
		offset: '0',
	}
	if (source.statuses.length > 0) params.status = source.statuses.join(',')
	for (const [key, wanted] of Object.entries(source.where)) params[`metadata.${key}`] = wanted
	const page = await api.objects.list(workspaceId, params)
	return page.map((object) => projectObjectRow(object, source.fields))
}

/**
 * Runs a list source as the viewer. Up to 100 rows is one call; more is a second call
 * pinned to the first call's moment with snapshot_at, so a row written between the two
 * cannot shift the pages. An `objects` list is always one call, at most 100 rows.
 */
export async function fetchListRows(
	workspaceId: string,
	source: ListSource,
	now: number = Date.now(),
): Promise<ListRow[]> {
	if (source.list === 'objects') return fetchObjectRows(workspaceId, source)
	const snapshotAt = new Date(now).toISOString()
	const rows: OpportunityRow[] = []
	while (rows.length < source.maxRows) {
		const limit = Math.min(PAGE_SIZE, source.maxRows - rows.length)
		const params: Record<string, string> = {
			type: 'bet',
			status: source.statuses.join(','),
			limit: String(limit),
			offset: String(rows.length),
			snapshot_at: snapshotAt,
		}
		if (source.updatedWithinDays !== null) {
			params.updated_after = new Date(now - source.updatedWithinDays * DAY_MS).toISOString()
		}
		const page = await api.objects.list(workspaceId, params)
		for (const object of page) rows.push(projectOpportunity(object))
		if (page.length < limit) break
	}
	return rows
}
