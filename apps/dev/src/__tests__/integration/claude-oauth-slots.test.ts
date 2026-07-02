import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import type { EncryptedOAuthData } from '../../lib/claude-oauth'
import { resolveActiveSlot } from '../../lib/claude-oauth-slots'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'

/**
 * AC-T1 of the Claude Code subscription failover bet: legacy single-slot
 * rows already on disk must continue to resolve as primary-only with no
 * migration. The resolver covered in the unit suite is the load-bearing
 * code path — this integration test pins the contract against real Postgres
 * to catch any JSONB serialisation / Drizzle round-trip surprises.
 */
describe('Claude OAuth slot resolver — integration', () => {
	it('resolves a seeded legacy-shape workspace as primary-only', async () => {
		const actor = await insertActor(db)
		const legacy: EncryptedOAuthData = {
			encryptedAccessToken: 'legacy-enc-access',
			encryptedRefreshToken: 'legacy-enc-refresh',
			expiresAt: 1_700_000_000_000,
			subscriptionType: 'pro',
			scopes: ['read'],
		}
		const ws = await insertWorkspace(db, actor.id, {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: legacy,
			},
		})

		const [stored] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const settings = stored.settings as Record<string, unknown>
		const active = resolveActiveSlot(settings.claude_oauth)

		expect(active).toEqual({ slot: 'primary', data: legacy })
	})

	it('resolves a new-shape workspace with both slots and failover state', async () => {
		const actor = await insertActor(db)
		const primary: EncryptedOAuthData = {
			encryptedAccessToken: 'primary-enc-access',
			encryptedRefreshToken: 'primary-enc-refresh',
			expiresAt: 1_700_000_500_000,
		}
		const backup: EncryptedOAuthData = {
			encryptedAccessToken: 'backup-enc-access',
			encryptedRefreshToken: 'backup-enc-refresh',
			expiresAt: 1_700_001_000_000,
		}
		const ws = await insertWorkspace(db, actor.id, {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: {
					primary,
					backup,
					failover: {
						active_slot: 'backup',
						last_primary_failure_at: 1_700_000_750_000,
						last_classified_reason: 'oauth_token_expired',
					},
				},
			},
		})

		const [stored] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const settings = stored.settings as Record<string, unknown>
		const active = resolveActiveSlot(settings.claude_oauth)

		expect(active).toEqual({ slot: 'backup', data: backup })
	})

	it('returns undefined for a workspace that has no claude_oauth configured', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id)

		const [stored] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const settings = stored.settings as Record<string, unknown>

		expect(resolveActiveSlot(settings.claude_oauth)).toBeUndefined()
	})
})
