import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'

// Stub the refresh side of getValidOAuthToken: the swap/disconnect/import
// paths don't depend on it, and /status would otherwise try to call the
// real Claude OAuth server in test.
vi.mock('../../lib/claude-oauth', async () => {
	const actual =
		await vi.importActual<typeof import('../../lib/claude-oauth')>('../../lib/claude-oauth')
	return {
		...actual,
		getValidOAuthToken: vi.fn().mockResolvedValue(null),
	}
})

import { insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: claudeOauthRoutes } = await import('../../routes/claude-oauth')

const seededPrimary = {
	encryptedAccessToken: 'primary-enc-access',
	encryptedRefreshToken: 'primary-enc-refresh',
	expiresAt: 1_900_000_000_000,
	subscriptionType: 'max-5x',
}
const seededBackup = {
	encryptedAccessToken: 'backup-enc-access',
	encryptedRefreshToken: 'backup-enc-refresh',
	expiresAt: 1_950_000_000_000,
	subscriptionType: 'pro',
}

function makeApp() {
	return createIntegrationApp({ path: '/api/claude-oauth', module: claudeOauthRoutes })
}

async function readClaudeOAuth(wsId: string): Promise<Record<string, unknown> | undefined> {
	const [row] = await db.select().from(workspaces).where(eq(workspaces.id, wsId)).limit(1)
	const settings = (row?.settings ?? {}) as Record<string, unknown>
	return settings.claude_oauth as Record<string, unknown> | undefined
}

describe('Claude OAuth Routes — slot writes (integration)', () => {
	it('POST /import to backup adds the slot next to an existing primary', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: { enabled_modules: ['work'], claude_oauth: { primary: seededPrimary } },
		})

		const res = await makeApp().request(
			jsonRequest(
				'POST',
				'/api/claude-oauth/import',
				{
					accessToken: 'new-backup-access',
					refreshToken: 'new-backup-refresh',
					expiresAt: 1_960_000_000_000,
					subscriptionType: 'pro',
					slot: 'backup',
				},
				{ 'x-workspace-id': ws.id },
			),
		)

		expect(res.status).toBe(200)
		const oauth = (await readClaudeOAuth(ws.id)) as {
			primary?: { encryptedAccessToken: string }
			backup?: { encryptedAccessToken: string }
		}
		expect(oauth.primary?.encryptedAccessToken).toBe('primary-enc-access')
		expect(oauth.backup?.encryptedAccessToken).toBeDefined()
	})

	it('POST /import clears stale failover state so session-start re-evaluates', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: {
					primary: seededPrimary,
					backup: seededBackup,
					failover: {
						active_slot: 'backup',
						last_classified_reason: 'auth_failed',
						last_primary_failure_at: 1_700_000_000_000,
					},
				},
			},
		})

		await makeApp().request(
			jsonRequest(
				'POST',
				'/api/claude-oauth/import',
				{
					accessToken: 'refreshed-primary-access',
					refreshToken: 'refreshed-primary-refresh',
					expiresAt: 1_970_000_000_000,
				},
				{ 'x-workspace-id': ws.id },
			),
		)

		const oauth = (await readClaudeOAuth(ws.id)) as {
			failover?: { active_slot: string; last_classified_reason?: string }
		}
		expect(oauth.failover?.active_slot).toBe('primary')
		expect(oauth.failover?.last_classified_reason).toBeUndefined()
	})

	it('POST /import to backup keeps active_slot on backup while primary is still unhealthy', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: {
					primary: seededPrimary,
					backup: seededBackup,
					failover: { active_slot: 'backup', last_classified_reason: 'quota_exhausted_weekly' },
				},
			},
		})

		await makeApp().request(
			jsonRequest(
				'POST',
				'/api/claude-oauth/import',
				{
					accessToken: 'rotated-backup-access',
					refreshToken: 'rotated-backup-refresh',
					expiresAt: 1_980_000_000_000,
					slot: 'backup',
				},
				{ 'x-workspace-id': ws.id },
			),
		)

		const oauth = (await readClaudeOAuth(ws.id)) as {
			failover?: { active_slot: string; last_classified_reason?: string }
		}
		// Rotating the backup's own credentials must not route session-start
		// back onto the still-broken primary.
		expect(oauth.failover?.active_slot).toBe('backup')
		expect(oauth.failover?.last_classified_reason).toBeUndefined()
	})

	it('POST /swap rotates primary↔backup data and resets failover (AC-U5)', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: {
					primary: seededPrimary,
					backup: seededBackup,
					failover: {
						active_slot: 'backup',
						last_classified_reason: 'quota_exhausted_weekly',
					},
				},
			},
		})

		const res = await makeApp().request(
			jsonRequest('POST', '/api/claude-oauth/swap', undefined, { 'x-workspace-id': ws.id }),
		)
		expect(res.status).toBe(200)

		const oauth = (await readClaudeOAuth(ws.id)) as {
			primary: { encryptedAccessToken: string }
			backup: { encryptedAccessToken: string }
			failover: { active_slot: string; last_classified_reason?: string }
		}
		expect(oauth.primary.encryptedAccessToken).toBe(seededBackup.encryptedAccessToken)
		expect(oauth.backup.encryptedAccessToken).toBe(seededPrimary.encryptedAccessToken)
		expect(oauth.failover.active_slot).toBe('primary')
		expect(oauth.failover.last_classified_reason).toBeUndefined()
	})

	it('DELETE with slot=backup leaves primary intact', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: { primary: seededPrimary, backup: seededBackup },
			},
		})

		const res = await makeApp().request(
			jsonDelete('/api/claude-oauth?slot=backup', { 'x-workspace-id': ws.id }),
		)
		expect(res.status).toBe(200)

		const oauth = (await readClaudeOAuth(ws.id)) as {
			primary?: unknown
			backup?: unknown
		}
		expect(oauth.primary).toBeDefined()
		expect(oauth.backup).toBeUndefined()
	})

	it('DELETE of the active slot repoints active_slot to the healthy remaining slot', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: {
					primary: seededPrimary,
					backup: seededBackup,
					failover: { active_slot: 'backup', last_classified_reason: 'quota_exhausted_weekly' },
				},
			},
		})

		const res = await makeApp().request(
			jsonDelete('/api/claude-oauth?slot=backup', { 'x-workspace-id': ws.id }),
		)
		expect(res.status).toBe(200)

		const oauth = (await readClaudeOAuth(ws.id)) as {
			primary?: unknown
			backup?: unknown
			failover?: { active_slot: string; last_classified_reason?: string }
		}
		expect(oauth.backup).toBeUndefined()
		// The disconnected slot was active — session-start must fall back to
		// the still-healthy primary instead of resolving to nothing.
		expect(oauth.failover?.active_slot).toBe('primary')
		expect(oauth.failover?.last_classified_reason).toBeUndefined()
	})

	it('DELETE of the default-active primary repoints active_slot to backup', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: { primary: seededPrimary, backup: seededBackup },
			},
		})

		const res = await makeApp().request(
			jsonDelete('/api/claude-oauth?slot=primary', { 'x-workspace-id': ws.id }),
		)
		expect(res.status).toBe(200)

		const oauth = (await readClaudeOAuth(ws.id)) as {
			primary?: unknown
			failover?: { active_slot: string }
		}
		expect(oauth.primary).toBeUndefined()
		expect(oauth.failover?.active_slot).toBe('backup')
	})

	it('DELETE with no slot drops the entire claude_oauth key (back-compat)', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: { primary: seededPrimary, backup: seededBackup },
			},
		})

		await makeApp().request(
			jsonRequest('DELETE', '/api/claude-oauth', undefined, { 'x-workspace-id': ws.id }),
		)

		const oauth = await readClaudeOAuth(ws.id)
		expect(oauth).toBeUndefined()
	})

	it('GET /status surfaces both slots and active_slot from a seeded failed-over workspace (AC-U3)', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: {
					primary: seededPrimary,
					backup: seededBackup,
					failover: {
						active_slot: 'backup',
						last_classified_reason: 'quota_exhausted_weekly',
						last_primary_failure_at: 1_700_000_000_000,
					},
				},
			},
		})

		const res = await makeApp().request(
			jsonGet('/api/claude-oauth/status', { 'x-workspace-id': ws.id }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			connected: boolean
			active_slot: string
			last_classified_reason?: string
			slots: { primary?: { subscription_type?: string }; backup?: { subscription_type?: string } }
		}
		expect(body.connected).toBe(true)
		expect(body.active_slot).toBe('backup')
		expect(body.last_classified_reason).toBe('quota_exhausted_weekly')
		expect(body.slots.primary?.subscription_type).toBe('max-5x')
		expect(body.slots.backup?.subscription_type).toBe('pro')
	})
})
