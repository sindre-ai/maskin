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

export interface ClientPaginationInput<T> {
	/** Full result set from the underlying API. Not mutated. */
	rows: readonly T[]
	/** Row cap for the returned page. */
	limit: number
	/** Snapshot upper bound for the walk (locked at first call, threaded
	 *  through every subsequent cursor hop). */
	snapshotAt: string
	/** Sort direction the walk was opened in. Locked for the whole cursor
	 *  chain so the keyset predicate stays consistent. */
	order: CursorSortOrder
	/** Decoded cursor when the caller resumed a walk; `null` on the first hop. */
	cursor: CursorState | null
	/** Extract the primary sort value from a row — usually an ISO timestamp
	 *  string like `createdAt`. Return `null`/`undefined` for rows with no
	 *  natural sort value (they will still be included, sorted below all
	 *  timed rows). */
	getSortValue: (row: T) => string | null | undefined
	/** Extract the row's tiebreaker id — used both as keyset tiebreaker and
	 *  as the `next_cursor.k.id`. */
	getId: (row: T) => string
	/**
	 * Enforce the snapshot upper bound (`sortValue <= snapshotAt`). Defaults
	 * to true. Set to `false` for row types whose sort values aren't
	 * timestamps and thus can't be compared against `snapshotAt` — e.g.
	 * `list_extensions`, whose rows are derived from workspace settings and
	 * carry no per-row insert time.
	 */
	applySnapshotFilter?: boolean
}

export interface ClientPaginationResult<T> {
	page: T[]
	nextCursor: string | null
}

/**
 * Client-side keyset pagination for MCP list tools whose backing API endpoint
 * has no server-side cursor support. The caller fetches the full result set
 * from the API, hands it here with a resolved cursor state, and gets back a
 * bounded page plus a `next_cursor` when more rows remain.
 *
 * Snapshot consistency: with `applySnapshotFilter` on (default) rows whose
 * sort value is strictly greater than `snapshotAt` — i.e. rows inserted after
 * the walk began — are excluded from every hop of the same walk, so inserts
 * mid-walk cannot leak in as duplicates or skips against the first-call
 * freeze. The cursor envelope shape and the encode/decode round-trip are
 * identical to the server-side keyset in `list_objects` etc., so the on-wire
 * contract stays the same across every list/search tool.
 */
export function paginateClientSide<T>(input: ClientPaginationInput<T>): ClientPaginationResult<T> {
	const { rows, limit, snapshotAt, order, cursor, getSortValue, getId } = input
	const applySnapshotFilter = input.applySnapshotFilter ?? true
	// Rows with no sort value are placed at the end of the ordering — they
	// can never be the keyset boundary and don't participate in snapshot
	// filtering (nothing to compare).
	const sortValueOf = (row: T): string | null => {
		const v = getSortValue(row)
		return typeof v === 'string' && v.length > 0 ? v : null
	}
	const cmp = (a: T, b: T): number => {
		const av = sortValueOf(a)
		const bv = sortValueOf(b)
		if (av == null && bv == null) {
			const aid = getId(a)
			const bid = getId(b)
			if (aid === bid) return 0
			return order === 'desc' ? (aid < bid ? 1 : -1) : aid < bid ? -1 : 1
		}
		if (av == null) return 1
		if (bv == null) return -1
		if (av !== bv) return order === 'desc' ? (av < bv ? 1 : -1) : av < bv ? -1 : 1
		const aid = getId(a)
		const bid = getId(b)
		if (aid === bid) return 0
		return order === 'desc' ? (aid < bid ? 1 : -1) : aid < bid ? -1 : 1
	}
	const sorted = [...rows].sort(cmp)
	const afterSnapshot = applySnapshotFilter
		? sorted.filter((row) => {
				const v = sortValueOf(row)
				if (v == null) return true
				return v <= snapshotAt
			})
		: sorted
	const afterCursor = cursor
		? afterSnapshot.filter((row) => {
				const v = sortValueOf(row) ?? ''
				const id = getId(row)
				const cv = cursor.k.sortValue
				const cid = cursor.k.id
				if (order === 'desc') {
					if (v < cv) return true
					if (v === cv && id < cid) return true
					return false
				}
				if (v > cv) return true
				if (v === cv && id > cid) return true
				return false
			})
		: afterSnapshot
	const page = afterCursor.slice(0, limit)
	if (afterCursor.length <= limit) return { page, nextCursor: null }
	const boundary = page[page.length - 1]
	if (!boundary) return { page, nextCursor: null }
	const sortValue = sortValueOf(boundary)
	if (sortValue == null) return { page, nextCursor: null }
	const nextCursor = encodeCursor({
		s: snapshotAt,
		o: order,
		k: { sortValue, id: getId(boundary) },
	})
	return { page, nextCursor }
}
