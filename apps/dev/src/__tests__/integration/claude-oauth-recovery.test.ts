import { events, workspaces } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { EncryptedOAuthData } from '../../lib/claude-oauth'
import {
	CLAUDE_SUBSCRIPTION_RECOVERED,
	PRIMARY_RECOVERY_COOLDOWN_MS,
	attemptPrimaryRecovery,
} from '../../lib/claude-oauth-recovery'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'

/**
 * AC-U6: after a failover, the next session start must try the primary
 * first AGAIN once ≥5 minutes have elapsed. If the probe succeeds the
 * active slot flips back to `primary` and a `claude_subscription_recovered`
 * event is emitted on the workspace. If the probe fails, stay on backup
 * and update `last_primary_failure_at`.
 *
 * These tests advance a fake clock past the cooldown and assert both the
 * event-emission and slot-flip contract against real Postgres.
 */

const PRIMARY: EncryptedOAuthData = {
	encryptedAccessToken: 'primary-enc-access',
	encryptedRefreshToken: 'primary-enc-refresh',
	expiresAt: 1_700_000_500_000,
}
const BACKUP: EncryptedOAuthData = {
	encryptedAccessToken: 'backup-enc-access',
	encryptedRefreshToken: 'backup-enc-refresh',
	expiresAt: 1_700_001_000_000,
}

const PRIOR_FAILURE_AT = 1_700_000_000_000

async function seedFailedOverWorkspace(actorId: string, overrides?: { lastFailureAt?: number }) {
	return insertWorkspace(db, actorId, {
		settings: {
			enabled_modules: ['work'],
			claude_oauth: {
				primary: PRIMARY,
				backup: BACKUP,
				failover: {
					active_slot: 'backup',
					last_primary_failure_at: overrides?.lastFailureAt ?? PRIOR_FAILURE_AT,
					last_classified_reason: 'auth_failed',
				},
			},
		},
	})
}

async function readClaudeOAuth(workspaceId: string) {
	const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	const settings = row.settings as Record<string, unknown>
	return settings.claude_oauth as
		| {
				primary?: EncryptedOAuthData
				backup?: EncryptedOAuthData
				failover?: {
					active_slot: string
					last_primary_failure_at?: number
					last_classified_reason?: string
				}
		  }
		| undefined
}

async function recoveryEventCount(workspaceId: string) {
	const rows = await db
		.select()
		.from(events)
		.where(
			and(eq(events.workspaceId, workspaceId), eq(events.action, CLAUDE_SUBSCRIPTION_RECOVERED)),
		)
	return rows.length
}

describe('Claude OAuth lazy primary recovery — integration', () => {
	it('flips active_slot to primary and emits exactly one recovered event when probe is healthy', async () => {
		const actor = await insertActor(db)
		const ws = await seedFailedOverWorkspace(actor.id)
		const now = PRIOR_FAILURE_AT + PRIMARY_RECOVERY_COOLDOWN_MS + 1

		const result = await attemptPrimaryRecovery({
			db,
			workspaceId: ws.id,
			actorId: actor.id,
			now,
			healthCheck: async () => ({ healthy: true }),
		})

		expect(result).toEqual({ recovered: true })

		const oauth = await readClaudeOAuth(ws.id)
		expect(oauth?.failover?.active_slot).toBe('primary')
		expect(oauth?.failover?.last_primary_failure_at).toBeUndefined()
		expect(oauth?.failover?.last_classified_reason).toBeUndefined()
		expect(oauth?.primary).toEqual(PRIMARY)
		expect(oauth?.backup).toEqual(BACKUP)

		expect(await recoveryEventCount(ws.id)).toBe(1)
	})

	it('emits the recovered event exactly once across concurrent attempts on the same workspace', async () => {
		const actor = await insertActor(db)
		const ws = await seedFailedOverWorkspace(actor.id)
		const now = PRIOR_FAILURE_AT + PRIMARY_RECOVERY_COOLDOWN_MS + 1

		const [first, second] = await Promise.all([
			attemptPrimaryRecovery({
				db,
				workspaceId: ws.id,
				actorId: actor.id,
				now,
				healthCheck: async () => ({ healthy: true }),
			}),
			attemptPrimaryRecovery({
				db,
				workspaceId: ws.id,
				actorId: actor.id,
				now,
				healthCheck: async () => ({ healthy: true }),
			}),
		])

		const recovered = [first, second].filter((r) => r.recovered === true)
		expect(recovered).toHaveLength(1)
		expect(await recoveryEventCount(ws.id)).toBe(1)

		const oauth = await readClaudeOAuth(ws.id)
		expect(oauth?.failover?.active_slot).toBe('primary')
	})

	it('does nothing and emits no event when the cooldown has not elapsed', async () => {
		const actor = await insertActor(db)
		const ws = await seedFailedOverWorkspace(actor.id)
		const now = PRIOR_FAILURE_AT + PRIMARY_RECOVERY_COOLDOWN_MS - 1

		const result = await attemptPrimaryRecovery({
			db,
			workspaceId: ws.id,
			actorId: actor.id,
			now,
			healthCheck: async () => {
				throw new Error('healthCheck must not be called inside the cooldown')
			},
		})

		expect(result).toEqual({ recovered: false, reason: 'cooldown' })

		const oauth = await readClaudeOAuth(ws.id)
		expect(oauth?.failover?.active_slot).toBe('backup')
		expect(oauth?.failover?.last_primary_failure_at).toBe(PRIOR_FAILURE_AT)
		expect(await recoveryEventCount(ws.id)).toBe(0)
	})

	it('stays on backup, updates last_primary_failure_at, and emits no event when the probe fails', async () => {
		const actor = await insertActor(db)
		const ws = await seedFailedOverWorkspace(actor.id)
		const now = PRIOR_FAILURE_AT + PRIMARY_RECOVERY_COOLDOWN_MS + 1

		const result = await attemptPrimaryRecovery({
			db,
			workspaceId: ws.id,
			actorId: actor.id,
			now,
			healthCheck: async () => ({ healthy: false, reason: 'quota_exhausted' }),
		})

		expect(result).toEqual({
			recovered: false,
			reason: 'unhealthy',
			detail: 'quota_exhausted',
		})

		const oauth = await readClaudeOAuth(ws.id)
		expect(oauth?.failover?.active_slot).toBe('backup')
		expect(oauth?.failover?.last_primary_failure_at).toBe(now)
		expect(oauth?.failover?.last_classified_reason).toBe('quota_exhausted')
		expect(await recoveryEventCount(ws.id)).toBe(0)
	})

	it('returns no_workspace when the workspace id does not exist', async () => {
		const actor = await insertActor(db)

		const result = await attemptPrimaryRecovery({
			db,
			workspaceId: '00000000-0000-0000-0000-000000000000',
			actorId: actor.id,
			now: PRIOR_FAILURE_AT + PRIMARY_RECOVERY_COOLDOWN_MS + 1,
			healthCheck: async () => ({ healthy: true }),
		})

		expect(result).toEqual({ recovered: false, reason: 'no_workspace' })
	})
})
