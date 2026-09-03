import type { EncryptedOAuthData } from './claude-oauth'

/**
 * A slot id. The first two are the historical `primary` / `backup` keys kept
 * for on-disk back-compat; everything beyond them is `slot_3`, `slot_4`, …
 * (1-based, so the id reads as "the third credential"). Ids are positions in
 * the failover chain, not stable handles for a particular credential — moving
 * a credential up the chain moves its data between ids (see `promoteSlot`).
 */
export type OAuthSlotKind = string

/**
 * Ceiling on how many Claude subscriptions one workspace can hold. The blobs
 * live inline on `workspaces.settings` (a jsonb column read on every session
 * start), and each carries two encrypted tokens — this keeps that row bounded
 * without being a limit anyone realistically hits.
 */
export const MAX_OAUTH_SLOTS = 10

/** Encrypted token blob persisted in a slot. Re-exported for downstream tasks. */
export type OAuthSlotData = EncryptedOAuthData

/** Per-slot failure record, written when a slot is classified as unusable. */
export interface OAuthSlotFailure {
	at?: number
	reason?: string
}

/**
 * Per-workspace failover state. `active_slot` names the slot session-start
 * reads; `failures` records why each slot last failed, keyed by slot id.
 *
 * The four `last_*` fields are LEGACY MIRRORS of `failures.primary` /
 * `failures.backup`. They are still written (see `writeFailoverState`) so a
 * rollback to a two-slot build keeps reading the same state, and still read
 * (see `readFailoverState`) so rows written before N-slot support normalise
 * into `failures`. `failures` is the single in-memory source of truth —
 * never read the mirrors directly.
 */
export interface OAuthFailoverState {
	active_slot: OAuthSlotKind
	failures?: Record<string, OAuthSlotFailure>
	last_primary_failure_at?: number
	last_backup_failure_at?: number
	last_classified_reason?: string
	last_backup_classified_reason?: string
}

/**
 * Storage shape on `workspaces.settings.claude_oauth`. `primary` and `backup`
 * stay top-level keys (no migration of existing rows, and a two-slot build
 * reading this row still finds both); slots beyond the second live under
 * `extras`, keyed by slot id.
 *
 * Legacy single-slot rows (an `EncryptedOAuthData` directly) continue to
 * validate against the union in `workspaceSettingsSchema` and are treated as
 * primary-only by every reader here.
 */
export interface OAuthSlotStorage {
	primary?: OAuthSlotData
	backup?: OAuthSlotData
	extras?: Record<string, OAuthSlotData>
	failover?: OAuthFailoverState
}

/** Slot record keyed by id. `primary`/`backup` are named for convenience. */
export type OAuthSlotMap = {
	primary?: OAuthSlotData
	backup?: OAuthSlotData
} & Record<string, OAuthSlotData | undefined>

const EXTRA_SLOT_RE = /^slot_(\d+)$/

/** Canonical id for chain position `index` (0-based). */
export function slotIdAt(index: number): OAuthSlotKind {
	if (index === 0) return 'primary'
	if (index === 1) return 'backup'
	return `slot_${index + 1}`
}

/** Chain position of a slot id, or `-1` when the id isn't a canonical one. */
export function slotIndexOf(id: string): number {
	if (id === 'primary') return 0
	if (id === 'backup') return 1
	const match = EXTRA_SLOT_RE.exec(id)
	if (!match) return -1
	const position = Number(match[1]) - 1
	// `slot_1` / `slot_2` would alias primary/backup — reject rather than
	// silently accepting two ids for one position.
	return position >= 2 && position < MAX_OAUTH_SLOTS ? position : -1
}

/** Is this a slot id this codebase can address? */
export function isSlotId(id: string): boolean {
	return slotIndexOf(id) >= 0
}

/**
 * Heuristic: legacy rows are `EncryptedOAuthData` directly — they carry
 * `encryptedAccessToken` at the top level. The new shape never does.
 */
function isLegacyShape(raw: unknown): raw is OAuthSlotData {
	return (
		typeof raw === 'object' &&
		raw !== null &&
		typeof (raw as Record<string, unknown>).encryptedAccessToken === 'string' &&
		typeof (raw as Record<string, unknown>).encryptedRefreshToken === 'string'
	)
}

function isNewShape(raw: unknown): raw is OAuthSlotStorage {
	return (
		typeof raw === 'object' &&
		raw !== null &&
		!isLegacyShape(raw) &&
		// Only treat as new-shape if at least one recognised key is present —
		// otherwise we'd silently accept arbitrary objects.
		('primary' in raw || 'backup' in raw || 'extras' in raw || 'failover' in raw)
	)
}

/**
 * Read every configured slot, keyed by id. Returns `{}` when nothing is
 * configured. Legacy single-slot rows surface as `{ primary }`.
 */
export function readSlots(raw: unknown): OAuthSlotMap {
	if (isLegacyShape(raw)) {
		return { primary: raw }
	}
	if (!isNewShape(raw)) return {}

	const slots: OAuthSlotMap = {}
	if (raw.primary) slots.primary = raw.primary
	if (raw.backup) slots.backup = raw.backup
	for (const [id, data] of Object.entries(raw.extras ?? {})) {
		// A hand-edited row could carry an id we can't place in the chain, or
		// one that duplicates primary/backup. Dropping it here keeps every
		// downstream reader working off ids that have a position.
		if (!data || id === 'primary' || id === 'backup' || !isSlotId(id)) continue
		slots[id] = data
	}
	return slots
}

/**
 * The failover chain: every configured slot, in the order session-start
 * tries them. Ids are positions, so the order is simply their index —
 * absent ids are skipped rather than compacted, which keeps ids (and the
 * per-slot failure records keyed by them) stable across a disconnect.
 */
export function readChain(raw: unknown): Array<{ id: OAuthSlotKind; data: OAuthSlotData }> {
	const slots = readSlots(raw)
	return Object.entries(slots)
		.filter((entry): entry is [string, OAuthSlotData] => Boolean(entry[1]))
		.map(([id, data]) => ({ id, data, index: slotIndexOf(id) }))
		.sort((a, b) => a.index - b.index)
		.map(({ id, data }) => ({ id, data }))
}

/** Lowest unoccupied slot id, or `undefined` when the workspace is at the cap. */
export function nextFreeSlotId(raw: unknown): OAuthSlotKind | undefined {
	const slots = readSlots(raw)
	for (let index = 0; index < MAX_OAUTH_SLOTS; index++) {
		const id = slotIdAt(index)
		if (!slots[id]) return id
	}
	return undefined
}

/**
 * The slot after `id` in the chain, or `undefined` when `id` is the last one
 * configured. Used by failover to walk forward through the chain.
 */
export function nextSlotAfter(raw: unknown, id: OAuthSlotKind): OAuthSlotKind | undefined {
	const chain = readChain(raw)
	const position = chain.findIndex((entry) => entry.id === id)
	if (position < 0) return undefined
	return chain[position + 1]?.id
}

/**
 * The legacy `last_*` mirrors for a set of failure records. Only defined
 * values are emitted — an explicit `undefined` would survive into the object
 * as a present-but-empty key, for no benefit.
 */
function mirrorsOf(failures: Record<string, OAuthSlotFailure>): Partial<OAuthFailoverState> {
	const mirrors: Partial<OAuthFailoverState> = {}
	if (failures.primary?.at !== undefined) mirrors.last_primary_failure_at = failures.primary.at
	if (failures.primary?.reason !== undefined) {
		mirrors.last_classified_reason = failures.primary.reason
	}
	if (failures.backup?.at !== undefined) mirrors.last_backup_failure_at = failures.backup.at
	if (failures.backup?.reason !== undefined) {
		mirrors.last_backup_classified_reason = failures.backup.reason
	}
	return mirrors
}

/**
 * Read the failover state, normalising the legacy `last_*` mirrors into
 * `failures`. Rows with no state default to the head of the chain (which is
 * `primary` for every legacy row), so the lookup behaves the same as before
 * N-slot support.
 */
export function readFailoverState(raw: unknown): OAuthFailoverState {
	const chain = readChain(raw)
	const head = chain[0]?.id ?? 'primary'
	const stored = isNewShape(raw) ? raw.failover : undefined
	if (!stored) return { active_slot: head }

	const failures: Record<string, OAuthSlotFailure> = {}
	for (const [id, failure] of Object.entries(stored.failures ?? {})) {
		if (failure && (typeof failure.at === 'number' || typeof failure.reason === 'string')) {
			failures[id] = { at: failure.at, reason: failure.reason }
		}
	}
	// Legacy mirrors fill in only where `failures` says nothing, so a row
	// written by this build wins over the mirrors it also wrote.
	if (!failures.primary && (stored.last_primary_failure_at || stored.last_classified_reason)) {
		failures.primary = {
			at: stored.last_primary_failure_at,
			reason: stored.last_classified_reason,
		}
	}
	if (!failures.backup && (stored.last_backup_failure_at || stored.last_backup_classified_reason)) {
		failures.backup = {
			at: stored.last_backup_failure_at,
			reason: stored.last_backup_classified_reason,
		}
	}

	// active_slot must name a slot we can place in the chain — fall back to
	// the head if a hand-edited row carries something unexpected.
	const activeSlot = typeof stored.active_slot === 'string' ? stored.active_slot : head
	return {
		active_slot: isSlotId(activeSlot) ? activeSlot : head,
		failures,
		...mirrorsOf(failures),
	}
}

/**
 * Every failure record a state carries, keyed by slot id.
 *
 * When `failures` is absent the legacy `last_*` mirrors are read instead, so a
 * state that hasn't been through `readFailoverState` — a hand-built one in a
 * test, or a two-slot-era value handed in by a caller — is understood the same
 * way. An EMPTY `failures` is authoritative: it means the records were
 * deliberately cleared, so the mirrors must not resurrect them.
 */
function effectiveFailures(state: OAuthFailoverState): Record<string, OAuthSlotFailure> {
	if (state.failures) return state.failures
	const derived: Record<string, OAuthSlotFailure> = {}
	if (state.last_primary_failure_at !== undefined || state.last_classified_reason !== undefined) {
		derived.primary = {
			at: state.last_primary_failure_at,
			reason: state.last_classified_reason,
		}
	}
	if (
		state.last_backup_failure_at !== undefined ||
		state.last_backup_classified_reason !== undefined
	) {
		derived.backup = {
			at: state.last_backup_failure_at,
			reason: state.last_backup_classified_reason,
		}
	}
	return derived
}

/** The failure last recorded for a slot, or `{}` when it has none. */
export function slotFailure(state: OAuthFailoverState, id: OAuthSlotKind): OAuthSlotFailure {
	return effectiveFailures(state)[id] ?? {}
}

/**
 * Record (or, with `undefined`, clear) a slot's failure, returning the new
 * state. Never mutates the input.
 */
export function withSlotFailure(
	state: OAuthFailoverState,
	id: OAuthSlotKind,
	failure: OAuthSlotFailure | undefined,
): OAuthFailoverState {
	const failures = { ...effectiveFailures(state) }
	if (failure && (failure.at !== undefined || failure.reason !== undefined)) {
		failures[id] = failure
	} else {
		delete failures[id]
	}
	return { ...state, failures }
}

/**
 * Resolve the slot the next session-start should use. Returns `undefined`
 * when the active slot has no data — e.g. a manually-rotated workspace
 * whose `active_slot` points at a disconnected slot, or a workspace with no
 * slots at all.
 */
export function resolveActiveSlot(
	raw: unknown,
): { slot: OAuthSlotKind; data: OAuthSlotData } | undefined {
	const slots = readSlots(raw)
	const failover = readFailoverState(raw)
	const data = slots[failover.active_slot]
	if (!data) return undefined
	return { slot: failover.active_slot, data }
}

/** Split a raw value into the storage shape, migrating a legacy row in place. */
function toStorage(raw: unknown): OAuthSlotStorage {
	if (isNewShape(raw)) {
		return {
			primary: raw.primary,
			backup: raw.backup,
			...(raw.extras ? { extras: { ...raw.extras } } : {}),
			failover: raw.failover,
		}
	}
	if (isLegacyShape(raw)) return { primary: raw }
	return {}
}

/** Drop `extras` when empty so a two-slot workspace stores nothing extra. */
function normalise(storage: OAuthSlotStorage): OAuthSlotStorage {
	if (storage.extras && Object.keys(storage.extras).length === 0) {
		const { extras: _, ...rest } = storage
		return rest
	}
	return storage
}

/**
 * Write a slot, returning the new storage value to persist back to
 * `settings.claude_oauth`. Always produces the new shape — legacy rows
 * are migrated in-place on first write of `primary`. Callers that want
 * to preserve a legacy read-only row should not call this for that row.
 */
export function writeSlot(
	raw: unknown,
	slot: OAuthSlotKind,
	data: OAuthSlotData,
): OAuthSlotStorage {
	const storage = toStorage(raw)
	if (slot === 'primary' || slot === 'backup') {
		return normalise({ ...storage, [slot]: data })
	}
	return normalise({ ...storage, extras: { ...(storage.extras ?? {}), [slot]: data } })
}

/**
 * Write the failover state, preserving any slots already on the row. The
 * legacy `last_*` mirrors are derived from `failures` here so they can never
 * drift from it — see `OAuthFailoverState`.
 */
export function writeFailoverState(raw: unknown, state: OAuthFailoverState): OAuthSlotStorage {
	const storage = toStorage(raw)
	const failures = effectiveFailures(state)
	const hasFailures = Object.keys(failures).length > 0
	return normalise({
		...storage,
		failover: {
			active_slot: state.active_slot,
			...(hasFailures ? { failures } : {}),
			...mirrorsOf(failures),
		},
	})
}

/**
 * Remove a slot, dropping any failure recorded against it. If nothing is
 * left, returns `undefined` so the caller can drop the key entirely.
 */
export function clearSlot(raw: unknown, slot: OAuthSlotKind): OAuthSlotStorage | undefined {
	const storage = toStorage(raw)
	const next: OAuthSlotStorage = { ...storage }
	if (slot === 'primary' || slot === 'backup') {
		delete next[slot]
	} else if (next.extras) {
		next.extras = { ...next.extras }
		delete next.extras[slot]
	}
	if (next.failover) {
		const cleared = withSlotFailure(readFailoverState(raw), slot, undefined)
		next.failover = writeFailoverState(next, cleared).failover
	}
	const normalised = normalise(next)
	if (readChain(normalised).length === 0 && !normalised.failover) return undefined
	return normalised
}

/**
 * Move `slot` to the head of the chain, rotating everything above it down one
 * position. The slot IDS stay exactly where they are — it's the credential
 * data that moves — so the head of the chain is always the lowest configured
 * id, and a two-slot workspace's head is always `primary`.
 *
 * Because the per-slot failure records are keyed by id and the data underneath
 * them has moved, callers must reset the failover state after a promote (all
 * of them do — a promote is a deliberate "try this one first now").
 */
export function promoteSlot(raw: unknown, slot: OAuthSlotKind): OAuthSlotStorage | undefined {
	const chain = readChain(raw)
	const position = chain.findIndex((entry) => entry.id === slot)
	if (position < 0) return undefined
	const promoted = chain[position]
	if (!promoted) return undefined
	const reordered = [promoted, ...chain.filter((_, i) => i !== position)]
	let next = toStorage(raw)
	for (const [index, entry] of reordered.entries()) {
		const target = chain[index]
		if (!target) continue
		next = writeSlot(next, target.id, entry.data)
	}
	return next
}
