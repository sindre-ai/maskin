import { describe, expect, it } from 'vitest'
import type { EncryptedOAuthData } from '../../lib/claude-oauth'
import {
	type OAuthSlotStorage,
	clearSlot,
	nextUsableSlotAfter,
	readFailoverState,
	readSlots,
	resolveActiveSlot,
	writeFailoverState,
	writeSlot,
} from '../../lib/claude-oauth-slots'

function slot(suffix: string, overrides?: Partial<EncryptedOAuthData>): EncryptedOAuthData {
	return {
		encryptedAccessToken: `enc-access-${suffix}`,
		encryptedRefreshToken: `enc-refresh-${suffix}`,
		expiresAt: 1_700_000_000_000,
		...overrides,
	}
}

describe('readSlots', () => {
	it('treats a legacy single-slot row as primary-only', () => {
		const legacy = slot('legacy')

		expect(readSlots(legacy)).toEqual({ primary: legacy })
	})

	it('reads both slots from the new shape', () => {
		const storage: OAuthSlotStorage = {
			primary: slot('p'),
			backup: slot('b'),
		}

		expect(readSlots(storage)).toEqual({ primary: storage.primary, backup: storage.backup })
	})

	it('returns an empty object for unset / missing rows', () => {
		expect(readSlots(undefined)).toEqual({})
		expect(readSlots(null)).toEqual({})
		expect(readSlots({})).toEqual({})
	})

	it('returns just backup when only backup is configured', () => {
		const storage: OAuthSlotStorage = { backup: slot('b') }

		expect(readSlots(storage)).toEqual({ primary: undefined, backup: storage.backup })
	})
})

describe('readFailoverState', () => {
	it('defaults legacy rows to active_slot=primary', () => {
		expect(readFailoverState(slot('legacy'))).toEqual({ active_slot: 'primary' })
	})

	it('returns the stored failover state from the new shape', () => {
		const storage: OAuthSlotStorage = {
			primary: slot('p'),
			backup: slot('b'),
			failover: {
				active_slot: 'backup',
				last_primary_failure_at: 1_700_000_500_000,
				last_classified_reason: 'oauth_token_expired',
			},
		}

		// The legacy `last_*` mirrors normalise into the per-slot `failures`
		// record, and are echoed back so a two-slot-era reader still works.
		expect(readFailoverState(storage)).toEqual({
			active_slot: 'backup',
			failures: { primary: { at: 1_700_000_500_000, reason: 'oauth_token_expired' } },
			last_primary_failure_at: 1_700_000_500_000,
			last_classified_reason: 'oauth_token_expired',
		})
	})

	it('falls back to primary when the stored active_slot is malformed', () => {
		const storage = {
			primary: slot('p'),
			failover: { active_slot: 'something-else' },
		}

		expect(readFailoverState(storage).active_slot).toBe('primary')
	})

	it('defaults to active_slot=primary for empty or missing rows', () => {
		expect(readFailoverState(undefined).active_slot).toBe('primary')
		expect(readFailoverState({}).active_slot).toBe('primary')
	})
})

describe('resolveActiveSlot', () => {
	it('resolves legacy rows to the primary slot (AC-T1)', () => {
		const legacy = slot('legacy')

		expect(resolveActiveSlot(legacy)).toEqual({ slot: 'primary', data: legacy })
	})

	it('resolves the new shape to primary when failover state is absent', () => {
		const storage: OAuthSlotStorage = { primary: slot('p'), backup: slot('b') }

		expect(resolveActiveSlot(storage)).toEqual({ slot: 'primary', data: storage.primary })
	})

	it('resolves the new shape to backup when active_slot=backup', () => {
		const storage: OAuthSlotStorage = {
			primary: slot('p'),
			backup: slot('b'),
			failover: { active_slot: 'backup' },
		}

		expect(resolveActiveSlot(storage)).toEqual({ slot: 'backup', data: storage.backup })
	})

	it('resolves a backup-only row to the backup — the head of what is configured', () => {
		// With no `failover` recorded, the active slot defaults to the head of
		// the chain rather than to the literal `primary` key. A workspace whose
		// only credential sits in `backup` (primary disconnected, say) is
		// serviceable, and reading it as "nothing configured" orphaned it.
		const storage: OAuthSlotStorage = { backup: slot('b') }

		expect(resolveActiveSlot(storage)).toEqual({ slot: 'backup', data: storage.backup })
	})

	it('returns undefined for unset or empty rows', () => {
		expect(resolveActiveSlot(undefined)).toBeUndefined()
		expect(resolveActiveSlot({})).toBeUndefined()
	})
})

describe('writeSlot', () => {
	it('upgrades a legacy row to the new shape on first write', () => {
		const legacy = slot('legacy')
		const next = slot('next')

		const result = writeSlot(legacy, 'primary', next)

		expect(result).toEqual({ primary: next })
		expect((result as Record<string, unknown>).encryptedAccessToken).toBeUndefined()
	})

	it('preserves the other slot and failover state when writing one slot', () => {
		const storage: OAuthSlotStorage = {
			primary: slot('p'),
			backup: slot('b'),
			failover: { active_slot: 'primary' },
		}
		const fresh = slot('fresh')

		const result = writeSlot(storage, 'backup', fresh)

		expect(result.primary).toEqual(storage.primary)
		expect(result.backup).toEqual(fresh)
		expect(result.failover).toEqual({ active_slot: 'primary' })
	})

	it('creates a fresh storage object when the input has nothing yet', () => {
		const fresh = slot('fresh')

		expect(writeSlot(undefined, 'primary', fresh)).toEqual({ primary: fresh })
		expect(writeSlot({}, 'backup', fresh)).toEqual({ backup: fresh })
	})
})

describe('writeFailoverState', () => {
	it('preserves both slots when updating failover state', () => {
		const storage: OAuthSlotStorage = { primary: slot('p'), backup: slot('b') }

		const result = writeFailoverState(storage, {
			active_slot: 'backup',
			last_primary_failure_at: 1_700_001_000_000,
			last_classified_reason: 'quota_exhausted',
		})

		expect(result.primary).toEqual(storage.primary)
		expect(result.backup).toEqual(storage.backup)
		expect(result.failover).toEqual({
			active_slot: 'backup',
			failures: { primary: { at: 1_700_001_000_000, reason: 'quota_exhausted' } },
			last_primary_failure_at: 1_700_001_000_000,
			last_classified_reason: 'quota_exhausted',
		})
	})

	it('upgrades a legacy row in place and records the new failover state', () => {
		const legacy = slot('legacy')

		const result = writeFailoverState(legacy, { active_slot: 'primary' })

		expect(result.primary).toEqual(legacy)
		expect(result.failover).toEqual({ active_slot: 'primary' })
	})
})

describe('clearSlot', () => {
	it('removes the named slot, leaving the other intact', () => {
		const storage: OAuthSlotStorage = { primary: slot('p'), backup: slot('b') }

		expect(clearSlot(storage, 'backup')).toEqual({ primary: storage.primary })
	})

	it('returns undefined when both slots and failover state are gone', () => {
		const storage: OAuthSlotStorage = { primary: slot('p') }

		expect(clearSlot(storage, 'primary')).toBeUndefined()
	})

	it('clears a legacy row when the only slot is cleared', () => {
		expect(clearSlot(slot('legacy'), 'primary')).toBeUndefined()
	})
})

/**
 * Reachability of a slot the pointer has already moved past.
 *
 * `nextSlotAfter` walks forward only and stops at the end of the chain, which
 * is why a workspace that had walked to its last subscription reported itself
 * permanently exhausted — the only route back was a recovery probe aimed at the
 * chain HEAD, so a healthy middle slot was unreachable no matter how long it had
 * been fine. `nextUsableSlotAfter` wraps, and skips what the provider told us is
 * still spent.
 */
describe('nextUsableSlotAfter', () => {
	const NOW = 1_800_000_000_000

	function chainOf(failures: Record<string, { at?: number; reason?: string; reset_at?: number }>) {
		return {
			primary: slot('primary'),
			backup: slot('backup'),
			extras: { slot_3: slot('three') },
			failover: { active_slot: 'slot_3', failures },
		} satisfies OAuthSlotStorage
	}

	it('wraps from the last slot back to the head', () => {
		expect(nextUsableSlotAfter(chainOf({}), 'slot_3', NOW)).toBe('primary')
	})

	it('skips a slot the provider says is still rate-limited', () => {
		const storage = chainOf({
			primary: { at: NOW - 1000, reason: 'quota', reset_at: NOW + 60_000 },
		})
		expect(nextUsableSlotAfter(storage, 'slot_3', NOW)).toBe('backup')
	})

	it('takes a slot back once its reset time has passed', () => {
		// The same record, read after the reset — this is the moment a spent
		// subscription becomes usable again, and nothing else has to happen for it.
		const storage = chainOf({ primary: { at: NOW - 60_000, reason: 'quota', reset_at: NOW - 1 } })
		expect(nextUsableSlotAfter(storage, 'slot_3', NOW)).toBe('primary')
	})

	it('tries a slot whose failure carries no reset time', () => {
		// "Failed once, no reset given" must not be read as "dead" — guessing that
		// is how a healthy subscription becomes permanently unreachable.
		const storage = chainOf({ primary: { at: NOW - 60_000, reason: 'oauth_revoked' } })
		expect(nextUsableSlotAfter(storage, 'slot_3', NOW)).toBe('primary')
	})

	it('returns undefined only when every other slot is still spent', () => {
		const storage = chainOf({
			primary: { reset_at: NOW + 60_000 },
			backup: { reset_at: NOW + 60_000 },
		})
		expect(nextUsableSlotAfter(storage, 'slot_3', NOW)).toBeUndefined()
	})

	it('never hands back the slot it was asked to move off', () => {
		const single = {
			primary: slot('primary'),
			failover: { active_slot: 'primary' },
		} satisfies OAuthSlotStorage
		expect(nextUsableSlotAfter(single, 'primary', NOW)).toBeUndefined()
	})
})

describe('readFailoverState — reset_at', () => {
	it('preserves a recorded reset time through a read', () => {
		// Dropping it here would silently disable every skip downstream: the walk
		// would re-probe a subscription it already knows is gone until tonight.
		const storage = {
			primary: slot('primary'),
			failover: {
				active_slot: 'primary',
				failures: { primary: { at: 1, reason: 'quota', reset_at: 1_789_416_000_000 } },
			},
		} satisfies OAuthSlotStorage
		expect(readFailoverState(storage).failures?.primary?.reset_at).toBe(1_789_416_000_000)
	})
})
