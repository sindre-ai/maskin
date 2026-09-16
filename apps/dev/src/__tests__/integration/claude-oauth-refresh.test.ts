import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import type { EncryptedOAuthData } from '../../lib/claude-oauth'
import { persistRefreshedSlot } from '../../lib/claude-oauth'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'

/**
 * AC-T4 of the Claude Code subscription failover bet: two refreshes targeting
 * different slots on the same workspace must both persist without clobbering
 * each other. Pins the slot-safe write path against real Postgres — only an
 * integration test exercises `db.transaction` + `SELECT ... FOR UPDATE`
 * serialization, which the unit-suite Drizzle mocks cannot model.
 */
describe('Claude OAuth refresh — slot-safe under concurrency', () => {
	const seedPrimary: EncryptedOAuthData = {
		encryptedAccessToken: 'p-old-enc',
		encryptedRefreshToken: 'p-old-enc-rt',
		expiresAt: 1_700_000_000_000,
		subscriptionType: 'pro',
	}
	const seedBackup: EncryptedOAuthData = {
		encryptedAccessToken: 'b-old-enc',
		encryptedRefreshToken: 'b-old-enc-rt',
		expiresAt: 1_700_000_100_000,
		subscriptionType: 'pro',
	}
	const freshPrimary: EncryptedOAuthData = {
		encryptedAccessToken: 'p-new-enc',
		encryptedRefreshToken: 'p-new-enc-rt',
		expiresAt: 1_800_000_000_000,
		subscriptionType: 'pro',
	}
	const freshBackup: EncryptedOAuthData = {
		encryptedAccessToken: 'b-new-enc',
		encryptedRefreshToken: 'b-new-enc-rt',
		expiresAt: 1_800_000_500_000,
		subscriptionType: 'pro',
	}

	it('persists both slots when two refreshes run in parallel on different slots', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id, {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: {
					primary: seedPrimary,
					backup: seedBackup,
					failover: { active_slot: 'primary' },
				},
			},
		})

		await Promise.all([
			persistRefreshedSlot(db, ws.id, 'primary', freshPrimary),
			persistRefreshedSlot(db, ws.id, 'backup', freshBackup),
		])

		const [stored] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const settings = stored.settings as Record<string, unknown>
		const claudeOAuth = settings.claude_oauth as Record<string, unknown>

		expect(claudeOAuth.primary).toEqual(freshPrimary)
		expect(claudeOAuth.backup).toEqual(freshBackup)
		expect(claudeOAuth.failover).toEqual({ active_slot: 'primary' })
		expect(settings.enabled_modules).toEqual(['work'])
	})

	it('preserves failover state when the active slot is refreshed', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id, {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: {
					primary: seedPrimary,
					backup: seedBackup,
					failover: {
						active_slot: 'backup',
						last_primary_failure_at: 1_700_000_750_000,
						last_classified_reason: 'quota_exhausted',
					},
				},
			},
		})

		await persistRefreshedSlot(db, ws.id, 'backup', freshBackup)

		const [stored] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const settings = stored.settings as Record<string, unknown>
		const claudeOAuth = settings.claude_oauth as Record<string, unknown>

		expect(claudeOAuth.backup).toEqual(freshBackup)
		expect(claudeOAuth.primary).toEqual(seedPrimary)
		expect(claudeOAuth.failover).toEqual({
			active_slot: 'backup',
			last_primary_failure_at: 1_700_000_750_000,
			last_classified_reason: 'quota_exhausted',
		})
	})

	it('keeps the slot nickname when a token refresh is persisted over it', async () => {
		// Regression: a refresh rebuilt the token record from the refresh
		// response, which carries no nickname, and `persistRefreshedSlot`
		// writes the slot wholesale — so every renamed subscription silently
		// lost its label the first time its token was refreshed.
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id, {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: {
					primary: { ...seedPrimary, nickname: 'Work account' },
					failover: { active_slot: 'primary' },
				},
			},
		})

		// `freshPrimary` has no nickname — exactly what a refreshed blob looks
		// like when the nickname is dropped upstream.
		await persistRefreshedSlot(db, ws.id, 'primary', freshPrimary)

		const [stored] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const settings = stored.settings as Record<string, unknown>
		const oauth = settings.claude_oauth as {
			primary: { encryptedAccessToken: string; nickname?: string }
		}
		expect(oauth.primary.encryptedAccessToken).toBe('p-new-enc')
		expect(oauth.primary.nickname).toBe('Work account')
	})

	it('lets a rename that lands after a refresh win', async () => {
		// The nickname is only carried over when the incoming blob has none —
		// a blob that explicitly names the slot must still be able to set it.
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id, {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: { primary: { ...seedPrimary, nickname: 'Old name' } },
			},
		})

		await persistRefreshedSlot(db, ws.id, 'primary', { ...freshPrimary, nickname: 'New name' })

		const [stored] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const settings = stored.settings as Record<string, unknown>
		const oauth = settings.claude_oauth as { primary: { nickname?: string } }
		expect(oauth.primary.nickname).toBe('New name')
	})

	it('upgrades a legacy single-slot row to the new shape on first refresh', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id, {
			settings: { enabled_modules: ['work'], claude_oauth: seedPrimary },
		})

		await persistRefreshedSlot(db, ws.id, 'primary', freshPrimary)

		const [stored] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const settings = stored.settings as Record<string, unknown>
		expect(settings.claude_oauth).toEqual({ primary: freshPrimary })
	})
})
