// The pure parts of `list_integrations`: which rows come first, which match a filter, what the
// summary says, and what a slim row keeps.
//
// A workspace collects dead rows: every aborted connect leaves a `pending` one, and a revoked or
// undone connection stays listed. Newest-first order buried the one live Slack row on page 3 of
// about 70, and an agent that read page 1 concluded Slack was not connected. So live rows come
// first, a summary says what is connected whatever the page, and `provider` / `status` / `q`
// find one thing without paging.

export interface IntegrationRow {
	id: string
	provider?: string
	status?: string
	displayName?: string | null
	createdAt?: string | null
	[key: string]: unknown
}

/** Statuses that mean "never finished connecting", the clutter that should sort last. */
const UNFINISHED_STATUSES = new Set(['pending', 'awaiting_secret', 'undone'])

/** 3 = live, 2 = a real connection that is not live (revoked, expired), 1 = unfinished. */
export function liveRank(row: IntegrationRow): 1 | 2 | 3 {
	if (row.status === 'active') return 3
	if (row.status && UNFINISHED_STATUSES.has(row.status)) return 1
	return 2
}

/**
 * The cursor sort value. Descending order puts the highest rank first, then the newest within a
 * rank. The rank leads, so a plain timestamp comparison no longer applies; the caller filters on
 * the snapshot itself.
 */
export function integrationSortKey(row: IntegrationRow): string {
	return `${liveRank(row)}|${row.createdAt ?? ''}`
}

/** What a person sees as the name: a saved label when there is one, else the provider. */
export function integrationLabel(row: IntegrationRow): string {
	return row.displayName?.trim() || row.provider || row.id
}

export interface IntegrationFilters {
	provider?: string
	status?: string
	q?: string
}

/**
 * `provider` and `status` match exactly, ignoring case. `q` is a case-insensitive substring of the
 * provider or the saved label, and every word of it must appear. Provider-side ids (a Slack team
 * id, a mailbox) are deliberately not searchable: they are not names a person uses.
 */
export function matchesIntegrationFilters(
	row: IntegrationRow,
	filters: IntegrationFilters,
): boolean {
	if (filters.provider && row.provider?.toLowerCase() !== filters.provider.trim().toLowerCase()) {
		return false
	}
	if (filters.status && row.status?.toLowerCase() !== filters.status.trim().toLowerCase()) {
		return false
	}
	const words = filters.q?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
	if (words.length > 0) {
		const haystack = `${row.provider ?? ''} ${row.displayName ?? ''}`.toLowerCase()
		if (!words.every((word) => haystack.includes(word))) return false
	}
	return true
}

export interface IntegrationSummary {
	/** Every integration row in the workspace, whatever the filters. */
	total_in_workspace: number
	/** Row count per status, for example `{ active: 24, pending: 31, revoked: 6 }`. */
	by_status: Record<string, number>
	/** Names of the live connections, sorted, so "is X connected" is answered on any page. */
	active: string[]
}

export function summarizeIntegrations(rows: readonly IntegrationRow[]): IntegrationSummary {
	const byStatus: Record<string, number> = {}
	const active = new Set<string>()
	for (const row of rows) {
		const status = row.status ?? 'unknown'
		byStatus[status] = (byStatus[status] ?? 0) + 1
		if (row.status === 'active') active.add(integrationLabel(row))
	}
	return {
		total_in_workspace: rows.length,
		by_status: byStatus,
		active: [...active].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
	}
}

/**
 * Fields a slim row keeps: enough to tell what the connection is, whether it works and who may use
 * it. Config, granted scopes, provider-side ids and the rest come back with `verbose: true`.
 */
const LEAN_FIELDS = [
	'id',
	'provider',
	'displayName',
	'status',
	'providerMode',
	'createdAt',
	'updatedAt',
	'needsReconnect',
	'missingScopes',
	'defaultAgentAccess',
	'agentGrants',
	'chatGrants',
] as const

export function leanIntegrationRow(row: IntegrationRow): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const field of LEAN_FIELDS) {
		if (field in row) out[field] = row[field]
	}
	return out
}
