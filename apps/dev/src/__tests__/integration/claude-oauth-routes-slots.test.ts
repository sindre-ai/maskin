import { workspaces } from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { MAX_OAUTH_SLOTS, readChain } from '../../lib/claude-oauth-slots'

// Stub the refresh side of getValidOAuthToken: the swap/disconnect/import
// paths don't depend on it, and /status would otherwise try to call the
// real Claude OAuth server in test.
vi.mock('../../lib/claude-oauth', async () => {
	const actual =
		await vi.importActual<typeof import('../../lib/claude-oauth')>('../../lib/claude-oauth')
	return {
		...actual,
		getValidOAuthToken: vi.fn().mockResolvedValue(null),
		// The account lookup is a live call to Anthropic's profile endpoint —
		// stubbed off by default so these tests exercise storage, not network.
		fetchClaudeAccount: vi.fn().mockResolvedValue(undefined),
	}
})

import { insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

import { ACCOUNT_LOOKUP_RETRY_MS, fetchClaudeAccount } from '../../lib/claude-oauth'

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

describe('Claude OAuth Routes — enterpriseGranted entitlement gate (integration)', () => {
	it('POST /import returns 403 when the workspace is not enterpriseGranted', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			enterpriseGranted: false,
			settings: { enabled_modules: ['work'] },
		})

		const res = await makeApp().request(
			jsonRequest(
				'POST',
				'/api/claude-oauth/import',
				{
					accessToken: 'blocked-access',
					refreshToken: 'blocked-refresh',
					expiresAt: 1_960_000_000_000,
				},
				{ 'x-workspace-id': ws.id },
			),
		)

		expect(res.status).toBe(403)
		const oauth = await readClaudeOAuth(ws.id)
		expect(oauth).toBeUndefined()
	})
})

describe('Claude OAuth Routes — slot writes (integration)', () => {
	it('POST /import to backup adds the slot next to an existing primary', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			enterpriseGranted: true,
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
			enterpriseGranted: true,
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
			enterpriseGranted: true,
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
		// back onto the still-broken primary — nor erase why the primary is
		// broken, now that failure records are kept per slot.
		expect(oauth.failover?.active_slot).toBe('backup')
		expect(oauth.failover?.last_classified_reason).toBe('quota_exhausted_weekly')
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

	it('PATCH /nickname sets a nickname without disturbing the slot tokens', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: { enabled_modules: ['work'], claude_oauth: { primary: seededPrimary } },
		})

		const res = await makeApp().request(
			jsonRequest(
				'PATCH',
				'/api/claude-oauth/nickname',
				{ slot: 'primary', nickname: 'Work account' },
				{ 'x-workspace-id': ws.id },
			),
		)
		expect(res.status).toBe(200)

		const oauth = (await readClaudeOAuth(ws.id)) as {
			primary?: { encryptedAccessToken: string; nickname?: string }
		}
		expect(oauth.primary?.nickname).toBe('Work account')
		expect(oauth.primary?.encryptedAccessToken).toBe('primary-enc-access')

		const statusRes = await makeApp().request(
			jsonGet('/api/claude-oauth/status', { 'x-workspace-id': ws.id }),
		)
		const statusBody = (await statusRes.json()) as { slots: { primary?: { nickname?: string } } }
		expect(statusBody.slots.primary?.nickname).toBe('Work account')
	})

	it('PATCH /nickname clears an existing nickname when given an empty string', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: { primary: { ...seededPrimary, nickname: 'Old name' } },
			},
		})

		await makeApp().request(
			jsonRequest(
				'PATCH',
				'/api/claude-oauth/nickname',
				{ slot: 'primary', nickname: '' },
				{ 'x-workspace-id': ws.id },
			),
		)

		const oauth = (await readClaudeOAuth(ws.id)) as { primary?: { nickname?: string } }
		expect(oauth.primary?.nickname).toBeUndefined()
	})

	it('PATCH /nickname returns 404 for a slot with no credentials', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: { enabled_modules: ['work'], claude_oauth: { primary: seededPrimary } },
		})

		const res = await makeApp().request(
			jsonRequest(
				'PATCH',
				'/api/claude-oauth/nickname',
				{ slot: 'backup', nickname: 'Backup account' },
				{ 'x-workspace-id': ws.id },
			),
		)
		expect(res.status).toBe(404)
	})
})

describe('Claude OAuth Routes — more than two subscriptions (integration)', () => {
	beforeEach(() => {
		// Several tests below assert how MANY account lookups happened, so the
		// shared module mock has to start each one at zero.
		vi.mocked(fetchClaudeAccount).mockClear()
		vi.mocked(fetchClaudeAccount).mockResolvedValue(undefined)
	})

	function importBody(suffix: string, slot?: string) {
		return {
			accessToken: `access-${suffix}`,
			refreshToken: `refresh-${suffix}`,
			expiresAt: 1_960_000_000_000,
			subscriptionType: 'pro',
			...(slot ? { slot } : {}),
		}
	}

	async function seedChain(length: number) {
		const ws = await insertWorkspace(db, getTestActorId(), {
			enterpriseGranted: true,
			settings: { enabled_modules: ['work'] },
		})
		for (let i = 0; i < length; i++) {
			const res = await makeApp().request(
				jsonRequest('POST', '/api/claude-oauth/import', importBody(`seed-${i}`, 'new'), {
					'x-workspace-id': ws.id,
				}),
			)
			expect(res.status).toBe(200)
		}
		return ws
	}

	it('POST /import with slot=new appends past the backup, filling the lowest free id', async () => {
		const ws = await seedChain(2)

		const res = await makeApp().request(
			jsonRequest('POST', '/api/claude-oauth/import', importBody('third', 'new'), {
				'x-workspace-id': ws.id,
			}),
		)

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ success: true, slot: 'slot_3' })
		const oauth = (await readClaudeOAuth(ws.id)) as {
			primary?: unknown
			backup?: unknown
			extras?: Record<string, { encryptedAccessToken: string }>
		}
		expect(oauth.primary).toBeDefined()
		expect(oauth.backup).toBeDefined()
		expect(oauth.extras?.slot_3?.encryptedAccessToken).toBeDefined()
	})

	it('POST /import with slot=new reuses a freed id rather than growing the chain', async () => {
		const ws = await seedChain(3)
		await makeApp().request(
			jsonDelete('/api/claude-oauth?slot=backup', { 'x-workspace-id': ws.id }),
		)

		const res = await makeApp().request(
			jsonRequest('POST', '/api/claude-oauth/import', importBody('refill', 'new'), {
				'x-workspace-id': ws.id,
			}),
		)

		expect(await res.json()).toMatchObject({ slot: 'backup' })
	})

	it('POST /import returns 409 once the workspace holds the maximum', async () => {
		const ws = await seedChain(MAX_OAUTH_SLOTS)

		const res = await makeApp().request(
			jsonRequest('POST', '/api/claude-oauth/import', importBody('overflow', 'new'), {
				'x-workspace-id': ws.id,
			}),
		)

		expect(res.status).toBe(409)
		expect(readChain(await readClaudeOAuth(ws.id))).toHaveLength(MAX_OAUTH_SLOTS)
	})

	it('POST /import rejects a slot id outside the addressable range', async () => {
		const ws = await seedChain(1)

		const res = await makeApp().request(
			jsonRequest('POST', '/api/claude-oauth/import', importBody('bogus', 'slot_99'), {
				'x-workspace-id': ws.id,
			}),
		)

		expect(res.status).toBe(400)
	})

	it('GET /status returns every slot with its chain position', async () => {
		const ws = await seedChain(3)

		const res = await makeApp().request(
			jsonGet('/api/claude-oauth/status', { 'x-workspace-id': ws.id }),
		)
		const body = (await res.json()) as {
			chain: string[]
			slots_remaining: number
			slots: Record<string, { position: number }>
		}

		expect(body.chain).toEqual(['primary', 'backup', 'slot_3'])
		expect(body.slots_remaining).toBe(MAX_OAUTH_SLOTS - 3)
		expect(body.slots.slot_3?.position).toBe(2)
	})

	it('DELETE of a middle slot leaves the other ids where they are', async () => {
		// Ids are positions, not handles: compacting them would re-point every
		// per-slot failure record at a different credential.
		const ws = await seedChain(3)

		await makeApp().request(
			jsonDelete('/api/claude-oauth?slot=backup', { 'x-workspace-id': ws.id }),
		)

		expect(readChain(await readClaudeOAuth(ws.id)).map((entry) => entry.id)).toEqual([
			'primary',
			'slot_3',
		])
	})

	it('DELETE of the active slot repoints at the NEXT slot in the chain', async () => {
		const ws = await seedChain(3)
		await makeApp().request(
			jsonRequest(
				'POST',
				'/api/claude-oauth/promote',
				{ slot: 'backup' },
				{
					'x-workspace-id': ws.id,
				},
			),
		)

		await makeApp().request(
			jsonDelete('/api/claude-oauth?slot=primary', { 'x-workspace-id': ws.id }),
		)

		const oauth = (await readClaudeOAuth(ws.id)) as { failover?: { active_slot: string } }
		expect(oauth.failover?.active_slot).toBe('backup')
	})

	it('POST /promote moves a fallback to the head and resets the failover state', async () => {
		const ws = await seedChain(3)
		const before = readChain(await readClaudeOAuth(ws.id))
		const promoted = before[2]

		const res = await makeApp().request(
			jsonRequest(
				'POST',
				'/api/claude-oauth/promote',
				{ slot: 'slot_3' },
				{
					'x-workspace-id': ws.id,
				},
			),
		)

		expect(res.status).toBe(200)
		const after = readChain(await readClaudeOAuth(ws.id))
		// The credential moved to the head; the ids themselves did not move.
		expect(after.map((entry) => entry.id)).toEqual(['primary', 'backup', 'slot_3'])
		expect(after[0]?.data.encryptedAccessToken).toBe(promoted?.data.encryptedAccessToken)
		expect(after[1]?.data.encryptedAccessToken).toBe(before[0]?.data.encryptedAccessToken)
		expect(after[2]?.data.encryptedAccessToken).toBe(before[1]?.data.encryptedAccessToken)
		const oauth = (await readClaudeOAuth(ws.id)) as {
			failover?: { active_slot: string; failures?: Record<string, unknown> }
		}
		expect(oauth.failover?.active_slot).toBe('primary')
		expect(oauth.failover?.failures ?? {}).toEqual({})
	})

	it('POST /promote returns 404 for a slot with no credentials', async () => {
		const ws = await seedChain(2)

		const res = await makeApp().request(
			jsonRequest(
				'POST',
				'/api/claude-oauth/promote',
				{ slot: 'slot_4' },
				{
					'x-workspace-id': ws.id,
				},
			),
		)

		expect(res.status).toBe(404)
	})

	it('PATCH /nickname names a slot beyond the first two', async () => {
		const ws = await seedChain(3)

		const res = await makeApp().request(
			jsonRequest(
				'PATCH',
				'/api/claude-oauth/nickname',
				{ slot: 'slot_3', nickname: 'Spare' },
				{
					'x-workspace-id': ws.id,
				},
			),
		)

		expect(res.status).toBe(200)
		const oauth = (await readClaudeOAuth(ws.id)) as {
			extras?: { slot_3?: { nickname?: string; encryptedAccessToken: string } }
		}
		expect(oauth.extras?.slot_3?.nickname).toBe('Spare')
		// Renaming must not disturb the credential itself.
		expect(oauth.extras?.slot_3?.encryptedAccessToken).toBeDefined()
	})

	it('stores a nickname given at import time and returns it from /status', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			enterpriseGranted: true,
			settings: { enabled_modules: ['work'] },
		})

		await makeApp().request(
			jsonRequest(
				'POST',
				'/api/claude-oauth/import',
				{ ...importBody('named'), nickname: 'Work account' },
				{ 'x-workspace-id': ws.id },
			),
		)

		const res = await makeApp().request(
			jsonGet('/api/claude-oauth/status', { 'x-workspace-id': ws.id }),
		)
		const body = (await res.json()) as { slots: Record<string, { nickname?: string }> }
		expect(body.slots.primary?.nickname).toBe('Work account')
	})

	it('keeps a slot nickname across a credential replacement', async () => {
		const ws = await seedChain(1)
		await makeApp().request(
			jsonRequest(
				'PATCH',
				'/api/claude-oauth/nickname',
				{ slot: 'primary', nickname: 'Work account' },
				{ 'x-workspace-id': ws.id },
			),
		)

		// Re-paste credentials into the same slot, carrying no nickname — what
		// the settings UI sends when someone replaces an expired subscription.
		await makeApp().request(
			jsonRequest('POST', '/api/claude-oauth/import', importBody('rotated', 'primary'), {
				'x-workspace-id': ws.id,
			}),
		)

		const oauth = (await readClaudeOAuth(ws.id)) as {
			primary?: { nickname?: string; encryptedAccessToken: string }
		}
		expect(oauth.primary?.nickname).toBe('Work account')
	})

	it('stores the Anthropic account identity and returns it from /status', async () => {
		vi.mocked(fetchClaudeAccount).mockResolvedValueOnce({
			email: 'owner@example.com',
			organization: 'Example Inc',
			fetchedAt: 1_800_000_000_000,
		})
		const ws = await insertWorkspace(db, getTestActorId(), {
			enterpriseGranted: true,
			settings: { enabled_modules: ['work'] },
		})

		await makeApp().request(
			jsonRequest('POST', '/api/claude-oauth/import', importBody('identified'), {
				'x-workspace-id': ws.id,
			}),
		)

		const res = await makeApp().request(
			jsonGet('/api/claude-oauth/status', { 'x-workspace-id': ws.id }),
		)
		const body = (await res.json()) as {
			slots: Record<string, { account_email?: string; account_organization?: string }>
		}
		expect(body.slots.primary?.account_email).toBe('owner@example.com')
		expect(body.slots.primary?.account_organization).toBe('Example Inc')
	})

	it('backfills the account identity for a slot connected before we read it', async () => {
		// Existing installs have no stored identity; the settings page fills it
		// in once, rather than waiting for the credential to be re-imported.
		const ws = await seedChain(1)
		expect((await readClaudeOAuth(ws.id)) as { primary?: { account?: unknown } }).toMatchObject({
			primary: {},
		})

		vi.mocked(fetchClaudeAccount).mockResolvedValueOnce({
			email: 'owner@example.com',
			fetchedAt: 1_800_000_000_000,
		})
		await makeApp().request(jsonGet('/api/claude-oauth/status', { 'x-workspace-id': ws.id }))

		// The row must hold the email ENCRYPTED — `GET /api/workspaces` returns
		// this blob wholesale to every workspace member, and to anything
		// holding a workspace API key.
		const oauth = (await readClaudeOAuth(ws.id)) as {
			primary?: { account?: { encryptedEmail?: string; email?: string } }
		}
		expect(oauth.primary?.account?.encryptedEmail).toBeDefined()
		expect(oauth.primary?.account?.encryptedEmail).not.toContain('owner@example.com')
		expect(oauth.primary?.account?.email).toBeUndefined()

		// ...and the API still renders it.
		const res = await makeApp().request(
			jsonGet('/api/claude-oauth/status', { 'x-workspace-id': ws.id }),
		)
		const body = (await res.json()) as { slots: Record<string, { account_email?: string }> }
		expect(body.slots.primary?.account_email).toBe('owner@example.com')
	})

	it('asks about an unreadable identity once a day, not on every page load', async () => {
		// The profile response shape is not ours to control. Without recording
		// the ATTEMPT, a shape we cannot parse would re-ask on every settings
		// page load for the rest of time.
		const ws = await seedChain(1)
		// Importing does its own lookup — count only what the status route asks.
		vi.mocked(fetchClaudeAccount).mockClear()
		vi.mocked(fetchClaudeAccount).mockResolvedValue(undefined)

		await makeApp().request(jsonGet('/api/claude-oauth/status', { 'x-workspace-id': ws.id }))
		expect(vi.mocked(fetchClaudeAccount)).toHaveBeenCalledTimes(1)

		// The attempt is stored with no email, which is what stops the retry.
		const oauth = (await readClaudeOAuth(ws.id)) as {
			primary?: { account?: { fetchedAt?: number; encryptedEmail?: string } }
		}
		expect(oauth.primary?.account?.fetchedAt).toEqual(expect.any(Number))
		expect(oauth.primary?.account?.encryptedEmail).toBeUndefined()

		await makeApp().request(jsonGet('/api/claude-oauth/status', { 'x-workspace-id': ws.id }))
		expect(vi.mocked(fetchClaudeAccount)).toHaveBeenCalledTimes(1)
	})

	it('re-asks once the retry window has elapsed', async () => {
		const ws = await seedChain(1)
		vi.mocked(fetchClaudeAccount).mockClear()
		vi.mocked(fetchClaudeAccount).mockResolvedValue(undefined)
		await makeApp().request(jsonGet('/api/claude-oauth/status', { 'x-workspace-id': ws.id }))
		expect(vi.mocked(fetchClaudeAccount)).toHaveBeenCalledTimes(1)

		// Age the recorded attempt past the retry window.
		const stale = Date.now() - ACCOUNT_LOOKUP_RETRY_MS - 1
		const [row] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const settings = (row?.settings ?? {}) as Record<string, unknown>
		const oauth = settings.claude_oauth as { primary: { account: { fetchedAt: number } } }
		oauth.primary.account.fetchedAt = stale
		await db
			.update(workspaces)
			.set({ settings: { ...settings, claude_oauth: oauth } })
			.where(eq(workspaces.id, ws.id))

		vi.mocked(fetchClaudeAccount).mockResolvedValueOnce({
			email: 'owner@example.com',
			fetchedAt: Date.now(),
		})
		const res = await makeApp().request(
			jsonGet('/api/claude-oauth/status', { 'x-workspace-id': ws.id }),
		)

		expect(vi.mocked(fetchClaudeAccount)).toHaveBeenCalledTimes(2)
		const body = (await res.json()) as { slots: Record<string, { account_email?: string }> }
		expect(body.slots.primary?.account_email).toBe('owner@example.com')
	})

	it('still renders /status when the account lookup fails', async () => {
		const ws = await seedChain(2)
		vi.mocked(fetchClaudeAccount).mockRejectedValue(new Error('network down'))

		const res = await makeApp().request(
			jsonGet('/api/claude-oauth/status', { 'x-workspace-id': ws.id }),
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as { chain: string[] }
		expect(body.chain).toEqual(['primary', 'backup'])
		vi.mocked(fetchClaudeAccount).mockResolvedValue(undefined)
	})

	it('keeps every stored slot parseable by the workspace settings schema', async () => {
		// The settings schema is strict, and several billing read paths parse
		// the whole settings object — an unmodelled key there reads back as
		// "no billing", not as a validation error anyone sees.
		const ws = await seedChain(3)
		await makeApp().request(
			jsonRequest(
				'PATCH',
				'/api/claude-oauth/nickname',
				{ slot: 'slot_3', nickname: 'Spare' },
				{
					'x-workspace-id': ws.id,
				},
			),
		)

		const [row] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const parsed = workspaceSettingsSchema.partial().safeParse(row?.settings ?? {})
		expect(parsed.success).toBe(true)
	})
})
