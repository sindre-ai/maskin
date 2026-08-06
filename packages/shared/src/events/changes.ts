/**
 * `updated` and `status_changed` events store one entry per changed top-level
 * column instead of two full pre/post-update object snapshots. On a 100 KB-content
 * bet, a single title edit used to ship both bodies (~200 KB); the diff shape
 * ships only the title's old + new (~200 bytes).
 *
 * Existing rows keep the old `{previous, updated}` snapshot shape — this module
 * also exposes helpers that read either shape so consumers can be shape-agnostic.
 */

export interface FieldChange {
	field: string
	old: unknown
	new: unknown
}

// How long the Undo chip on a Knowledge Author write stays valid. Server and
// client both derive expiry from the original event's createdAt against this
// same constant so the two agree without a cron cleanup job.
export const KNOWLEDGE_WRITE_UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Whitelist of first-class object columns that carry user-authored diffs.
 * `id`, `type`, `workspaceId`, `createdAt`, `updatedAt`, `createdBy` are skipped
 * (either immutable or auto-managed).
 */
/**
 * Order here also controls the visual order of clauses in `formatObjectUpdate`
 * — kept as {status, driver, title, content, metadata, activeSessionId} to
 * match the pre-existing formatter output.
 */
export const OBJECT_DIFF_FIELDS = [
	'status',
	'driver',
	'title',
	'content',
	'metadata',
	'activeSessionId',
] as const

export const WORKSPACE_ADMIN_DIFF_FIELDS = ['onboardingEnabled', 'byollmAllowed'] as const

/**
 * Compare two records and return one FieldChange per whitelisted field whose
 * value actually differs. Returns `[]` when nothing on the whitelist changed.
 */
export function computeChanges(
	prev: Record<string, unknown> | null | undefined,
	next: Record<string, unknown> | null | undefined,
	fields: readonly string[],
): FieldChange[] {
	if (!prev || !next) return []
	const changes: FieldChange[] = []
	for (const field of fields) {
		const oldVal = prev[field]
		const newVal = next[field]
		if (!isEqual(oldVal, newVal)) {
			changes.push({ field, old: oldVal, new: newVal })
		}
	}
	return changes
}

/** Read `data.changes` from a new-shape event payload, or null when absent/invalid. */
export function readChanges(data: unknown): FieldChange[] | null {
	if (!data || typeof data !== 'object') return null
	const raw = (data as { changes?: unknown }).changes
	if (!Array.isArray(raw)) return null
	const valid: FieldChange[] = []
	for (const entry of raw) {
		if (entry && typeof entry === 'object' && typeof (entry as FieldChange).field === 'string') {
			valid.push(entry as FieldChange)
		}
	}
	return valid
}

/**
 * Derive a change list from a legacy `{previous, updated}` snapshot payload
 * so consumers can treat old and new events uniformly.
 */
export function changesFromSnapshot(
	data: unknown,
	fields: readonly string[],
): FieldChange[] | null {
	if (!data || typeof data !== 'object') return null
	const snap = data as { previous?: unknown; updated?: unknown }
	const prev = snap.previous
	const next = snap.updated
	if (!prev || !next) return null
	if (typeof prev !== 'object' || typeof next !== 'object') return null
	return computeChanges(prev as Record<string, unknown>, next as Record<string, unknown>, fields)
}

/**
 * Shape-agnostic reader: prefer new `data.changes`, fall back to a legacy
 * `{previous, updated}` snapshot diff.
 */
export function getChangesFromEventData(
	data: unknown,
	fields: readonly string[],
): FieldChange[] | null {
	const fromNew = readChanges(data)
	if (fromNew) return fromNew
	return changesFromSnapshot(data, fields)
}

export function findChange(
	changes: FieldChange[] | null | undefined,
	field: string,
): FieldChange | undefined {
	if (!changes) return undefined
	return changes.find((c) => c.field === field)
}

/**
 * Undo `changes` against `current` to recover the pre-update state.
 * Used when the trigger runner needs `previous` for a status transition check
 * on a new-shape event (which no longer ships the full snapshot).
 */
export function reversePatch<T extends Record<string, unknown>>(
	current: T,
	changes: FieldChange[],
): T {
	const result: Record<string, unknown> = { ...current }
	for (const change of changes) {
		result[change.field] = change.old
	}
	return result as T
}

function isEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (a == null && b == null) return true
	if (a == null || b == null) return false
	if (typeof a !== typeof b) return false
	if (typeof a === 'object') {
		return JSON.stringify(a) === JSON.stringify(b)
	}
	return false
}
