import { describe, expect, it } from 'vitest'
import type { EncryptedOAuthData } from '../../lib/claude-oauth'
import {
	PRIMARY_RECOVERY_COOLDOWN_MS,
	shouldAttemptPrimaryRecovery,
} from '../../lib/claude-oauth-recovery'

function slot(suffix: string): EncryptedOAuthData {
	return {
		encryptedAccessToken: `enc-access-${suffix}`,
		encryptedRefreshToken: `enc-refresh-${suffix}`,
		expiresAt: 1_700_000_000_000,
	}
}

const PRIMARY = slot('p')
const BACKUP = slot('b')

describe('shouldAttemptPrimaryRecovery', () => {
	it('returns false when the workspace is still routed to primary', () => {
		expect(
			shouldAttemptPrimaryRecovery({
				slots: { primary: PRIMARY, backup: BACKUP },
				failover: { active_slot: 'primary' },
				now: 1_700_000_000_000,
			}),
		).toBe(false)
	})

	it('returns false when no primary slot is configured', () => {
		expect(
			shouldAttemptPrimaryRecovery({
				slots: { backup: BACKUP },
				failover: { active_slot: 'backup', last_primary_failure_at: 1 },
				now: 1_700_000_000_000,
			}),
		).toBe(false)
	})

	it('returns false when the cooldown has not elapsed', () => {
		const lastFailure = 1_700_000_000_000
		expect(
			shouldAttemptPrimaryRecovery({
				slots: { primary: PRIMARY, backup: BACKUP },
				failover: { active_slot: 'backup', last_primary_failure_at: lastFailure },
				now: lastFailure + PRIMARY_RECOVERY_COOLDOWN_MS - 1,
			}),
		).toBe(false)
	})

	it('returns true once the cooldown has elapsed exactly', () => {
		const lastFailure = 1_700_000_000_000
		expect(
			shouldAttemptPrimaryRecovery({
				slots: { primary: PRIMARY, backup: BACKUP },
				failover: { active_slot: 'backup', last_primary_failure_at: lastFailure },
				now: lastFailure + PRIMARY_RECOVERY_COOLDOWN_MS,
			}),
		).toBe(true)
	})

	it('returns true with no recorded prior failure (post-manual-switch case)', () => {
		expect(
			shouldAttemptPrimaryRecovery({
				slots: { primary: PRIMARY, backup: BACKUP },
				failover: { active_slot: 'backup' },
				now: 1_700_000_000_000,
			}),
		).toBe(true)
	})

	it('honours a caller-supplied cooldown override', () => {
		const lastFailure = 1_700_000_000_000
		expect(
			shouldAttemptPrimaryRecovery({
				slots: { primary: PRIMARY, backup: BACKUP },
				failover: { active_slot: 'backup', last_primary_failure_at: lastFailure },
				now: lastFailure + 10_000,
				cooldownMs: 10_000,
			}),
		).toBe(true)
	})
})
