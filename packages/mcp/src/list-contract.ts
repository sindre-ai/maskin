// Pure helpers for the list contract (wave 2, T3): the one query path behind list_objects, with
// search_objects as a listed alias of it. Handlers and wiring live in server.ts.

import type { LIST_OBJECTS_SORTS } from './tools.js'

/**
 * Rollback switch for the list contract. Read when a server is created, from the process
 * environment, so a changed value takes effect only after a restart (Infra & DevOps changes it).
 * Off: search_objects and list_objects register their pre-contract definitions and run their
 * pre-contract handlers.
 */
export const LIST_CONTRACT_ENV_VAR = 'MASKIN_MCP_LIST_CONTRACT'

const OFF_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled'])

/** On unless the variable is set to one of the off values. Unset or anything else means on. */
export function isListContractEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const raw = env[LIST_CONTRACT_ENV_VAR]?.trim().toLowerCase()
	return !(raw && OFF_VALUES.has(raw))
}

export type ListObjectsSort = (typeof LIST_OBJECTS_SORTS)[number]

export interface ResolvedListSort {
	/** The column the API orders and snapshots on. */
	apiSort: 'createdAt' | 'updatedAt'
	order: 'asc' | 'desc'
}

export const RELEVANCE_NEEDS_Q_MESSAGE =
	'Invalid sort: relevance needs q. Pass q with the search text, or pick created_at_desc, created_at_asc, updated_at_desc or updated_at_asc.'

/**
 * Maps the `sort` argument onto the API's column and direction. `relevance` is the default with
 * `q` and an error without it. Under `q` the API ranks by match quality whatever column is sent,
 * so the column only decides what the walk's snapshot freezes.
 */
export function resolveListSort(
	sort: ListObjectsSort | undefined,
	hasQ: boolean,
): ResolvedListSort {
	if (sort === 'relevance' && !hasQ) throw new Error(RELEVANCE_NEEDS_Q_MESSAGE)
	switch (sort) {
		case 'created_at_asc':
			return { apiSort: 'createdAt', order: 'asc' }
		case 'updated_at_asc':
			return { apiSort: 'updatedAt', order: 'asc' }
		case 'updated_at_desc':
			return { apiSort: 'updatedAt', order: 'desc' }
		default:
			return { apiSort: 'createdAt', order: 'desc' }
	}
}

/**
 * The `status` argument (one string or a list) as the API's comma-separated value, or undefined
 * for no filter. The API already splits `status` on commas and matches any of them, so a list
 * needs no API change.
 */
export function statusFilterParam(status: string | string[] | undefined): string | undefined {
	if (status === undefined) return undefined
	const values = (Array.isArray(status) ? status : [status])
		.flatMap((s) => s.split(','))
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
	return values.length > 0 ? values.join(',') : undefined
}

/** One row of `detail: "concise"`: the fields a caller needs to pick an object, no content. */
export function conciseObjectRow(row: Record<string, unknown>): Record<string, unknown> {
	return {
		id: row.id,
		type: row.type,
		title: row.title,
		status: row.status,
		driver: row.driver ?? null,
		updatedAt: row.updatedAt,
		url: row.url,
	}
}
