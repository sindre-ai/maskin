import { type ObjectResponse, api } from '@/lib/api'

// Named lists a view may ask the file viewer for (see the bridge section in
// mini-app.ts). A view names a list in its maskin-sources block:
//   {"opps": {"list": "opportunities", "params": {"status": ["opportunity"]}}}
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

export interface OpportunitiesListSource {
	list: 'opportunities'
	statuses: string[]
	maxRows: number
	updatedWithinDays: number | null
}

/** A declared list source, or `null` when the declaration asks for something the app does not offer. */
export type ListSourceEntry = OpportunitiesListSource | null

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

/** The answer a view gets for a list source. `rows` is null until the first Refresh click. */
export type ListAnswer =
	| { rows: null; notRefreshed: true }
	| { rows: OpportunityRow[]; fetchedAt: number }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** True for a manifest entry that names a list, as opposed to a count query. */
export function isListDeclaration(value: unknown): boolean {
	return isPlainObject(value) && Object.hasOwn(value, 'list')
}

export function parseListSource(value: unknown): ListSourceEntry {
	if (!isPlainObject(value)) return null
	for (const key of Object.keys(value)) if (key !== 'list' && key !== 'params') return null
	if (value.list !== 'opportunities') return null
	const params = value.params === undefined ? {} : value.params
	if (!isPlainObject(params)) return null
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

/**
 * Runs a list source as the viewer. Up to 100 rows is one call; more is a second call
 * pinned to the first call's moment with snapshot_at, so a row written between the two
 * cannot shift the pages.
 */
export async function fetchListRows(
	workspaceId: string,
	source: OpportunitiesListSource,
	now: number = Date.now(),
): Promise<OpportunityRow[]> {
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
