import type { EncryptedOAuthData } from './claude-oauth'

export type OAuthSlotKind = 'primary' | 'backup'

/** Encrypted token blob persisted in a slot. Re-exported for downstream tasks. */
export type OAuthSlotData = EncryptedOAuthData

/**
 * Per-workspace failover state. Lives next to the slots on
 * `workspaces.settings.claude_oauth`. T4-T7 update this; T1 only defines
 * the shape and resolves the currently-active slot from it.
 */
export interface OAuthFailoverState {
	last_primary_failure_at?: number
	last_backup_failure_at?: number
	active_slot: OAuthSlotKind
	last_classified_reason?: string
	last_backup_classified_reason?: string
}

/**
 * New (post-T1) storage shape on `workspaces.settings.claude_oauth`.
 * Legacy single-slot rows continue to validate against the union in
 * `workspaceSettingsSchema` and `readSlots`/`resolveActiveSlot` treat them
 * as primary-only.
 */
export interface OAuthSlotStorage {
	primary?: OAuthSlotData
	backup?: OAuthSlotData
	failover?: OAuthFailoverState
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
		('primary' in raw || 'backup' in raw || 'failover' in raw)
	)
}

/**
 * Read both slots from either shape. Returns `{}` when nothing is configured.
 * Legacy single-slot rows surface as `{ primary }` with no backup.
 */
export function readSlots(raw: unknown): { primary?: OAuthSlotData; backup?: OAuthSlotData } {
	if (isLegacyShape(raw)) {
		return { primary: raw }
	}
	if (isNewShape(raw)) {
		return { primary: raw.primary, backup: raw.backup }
	}
	return {}
}

/**
 * Read the failover state. Legacy rows default to
 * `{ active_slot: 'primary' }` so the lookup behaves the same as today.
 */
export function readFailoverState(raw: unknown): OAuthFailoverState {
	if (isNewShape(raw) && raw.failover) {
		// active_slot must be one of the two literals — fall back to primary
		// if a manually-edited row carries something unexpected.
		const slot: OAuthSlotKind = raw.failover.active_slot === 'backup' ? 'backup' : 'primary'
		return {
			active_slot: slot,
			last_primary_failure_at: raw.failover.last_primary_failure_at,
			last_backup_failure_at: raw.failover.last_backup_failure_at,
			last_classified_reason: raw.failover.last_classified_reason,
			last_backup_classified_reason: raw.failover.last_backup_classified_reason,
		}
	}
	return { active_slot: 'primary' }
}

/**
 * Resolve the slot the next session-start should use. Returns `undefined`
 * when the active slot has no data — e.g. a manually-rotated workspace
 * with only a backup configured but `active_slot: 'primary'`, or a
 * workspace with no slots at all. T6 reads this at session start.
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
	const existing: OAuthSlotStorage = isNewShape(raw)
		? { primary: raw.primary, backup: raw.backup, failover: raw.failover }
		: isLegacyShape(raw)
			? { primary: raw }
			: {}
	return { ...existing, [slot]: data }
}

/**
 * Write the failover state, preserving any slots already on the row.
 */
export function writeFailoverState(raw: unknown, state: OAuthFailoverState): OAuthSlotStorage {
	const existing: OAuthSlotStorage = isNewShape(raw)
		? { primary: raw.primary, backup: raw.backup, failover: raw.failover }
		: isLegacyShape(raw)
			? { primary: raw }
			: {}
	return { ...existing, failover: state }
}

/**
 * Remove a slot. If both slots end up undefined and no failover state
 * remains, returns `undefined` so the caller can drop the key entirely.
 */
export function clearSlot(raw: unknown, slot: OAuthSlotKind): OAuthSlotStorage | undefined {
	const slots = readSlots(raw)
	const failover = isNewShape(raw) ? raw.failover : undefined
	const next: OAuthSlotStorage = { ...slots, failover }
	delete next[slot]
	if (!next.primary && !next.backup && !next.failover) return undefined
	return next
}
