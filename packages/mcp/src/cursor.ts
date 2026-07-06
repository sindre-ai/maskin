// Cursor pagination for list/search MCP tools.
//
// A cursor is a base64url-encoded JSON envelope that carries the snapshot
// captured at first-call time plus the keyset "seek" position of the last
// row returned. Subsequent tool calls decode the cursor and forward the
// snapshot + seek to the API so an insert in the underlying table between
// pages cannot skip or duplicate rows against the first-call snapshot
// (AC-T3).
//
// Envelope is deliberately compact: agents pay for every byte carried in
// their transcript.

/** Current cursor envelope version. Bump when the shape changes so old
 *  cursors from an in-flight page walk fail loudly instead of silently
 *  mis-decoding into new fields. */
export const CURSOR_VERSION = 1

export type CursorSortOrder = 'asc' | 'desc'

/** Keyset seek position — the (sort-value, id) tuple of the last row on
 *  the previous page. The next-page query filters rows strictly past this
 *  tuple in the encoded order, giving no skip / no duplicate guarantees
 *  under the snapshot upper bound. */
export interface CursorKeyset {
	/** Primary sort value of the last row (ISO timestamp for `createdAt`). */
	sortValue: string
	/** Tiebreaker: primary key uuid of the last row. */
	id: string
}

/** The state a paginated list tool needs to resume iteration snapshot-
 *  consistently. */
export interface CursorState {
	/** Envelope schema version. */
	v: number
	/** Snapshot upper bound, captured at first-call time as an ISO
	 *  timestamp. Every subsequent call re-uses this exact string so the
	 *  API applies the same `created_at <= snapshot_at` filter on every
	 *  hop of the walk. */
	s: string
	/** Sort direction the walk was opened in. Locked for the whole walk
	 *  so the keyset predicate stays consistent. */
	o: CursorSortOrder
	/** Last-seen keyset position. */
	k: CursorKeyset
}

/** Encode cursor state as a URL-safe base64 string. */
export function encodeCursor(state: Omit<CursorState, 'v'>): string {
	const payload: CursorState = { v: CURSOR_VERSION, ...state }
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Decode a cursor string. Returns `null` when the input is empty,
 *  malformed, or carries an unknown version — callers treat that the
 *  same as "no cursor" so a stale envelope never crashes a walk. */
export function decodeCursor(raw: string | undefined | null): CursorState | null {
	if (typeof raw !== 'string' || raw.length === 0) return null
	let json: string
	try {
		json = Buffer.from(raw, 'base64url').toString('utf8')
	} catch {
		return null
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== 'object') return null
	const p = parsed as Record<string, unknown>
	if (p.v !== CURSOR_VERSION) return null
	if (typeof p.s !== 'string' || p.s.length === 0) return null
	if (p.o !== 'asc' && p.o !== 'desc') return null
	const k = p.k as Record<string, unknown> | undefined
	if (!k || typeof k.sortValue !== 'string' || typeof k.id !== 'string') return null
	return {
		v: CURSOR_VERSION,
		s: p.s,
		o: p.o,
		k: { sortValue: k.sortValue, id: k.id },
	}
}

/** Format a Date (or ISO string) as a stable ISO snapshot identifier. */
export function toSnapshotAt(input: Date | string): string {
	if (typeof input === 'string') return input
	return input.toISOString()
}
