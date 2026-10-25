import { randomBytes } from 'node:crypto'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, vi } from 'vitest'
import { mergeDriveConfig } from '../../lib/integrations/providers/google-drive/watch'
import type { PostInstallContext, ResolvedProvider } from '../../lib/integrations/types'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/integration-events', () => ({
	trackIntegrationConnected: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/integrations/registry', async () => {
	const actual = await vi.importActual<typeof import('../../lib/integrations/registry')>(
		'../../lib/integrations/registry',
	)
	return {
		...actual,
		getProvider: vi.fn(actual.getProvider),
	}
})

const { getProvider } = await import('../../lib/integrations/registry')
const { trackIntegrationConnected } = await import('../../lib/analytics/integration-events')
const { default: integrationsRoutes } = await import('../../routes/integrations')
const { encrypt, decrypt } = await import('../../lib/crypto')

function buildApp() {
	return createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
}

// Regression coverage for the (workspace_id, provider, external_id) unique
// constraint: providers that resolve a STABLE externalId after token exchange
// (GitHub's installation_id, or a resolveExternalId provider like Google
// Calendar's account email) must refresh the existing active row on reconnect
// instead of promoting the fresh "pending" row — which would carry the same
// externalId and violate `integrations_ws_provider_external_uniq` at commit
// time. This exercises the real unique index against Postgres, not a mock.
describe('GET /api/integrations/:provider/callback — reconnect against a stable externalId', () => {
	it('refreshes the existing active row in place instead of violating the unique constraint', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		const providerName = `test-email-provider-${randomBytes(4).toString('hex')}`
		const stableExternalId = 'reconnect@example.com'

		const testProvider: ResolvedProvider = {
			config: {
				name: providerName,
				displayName: `Test Email Provider ${providerName}`,
				auth: {
					type: 'oauth2',
					config: {
						authorizationUrl: 'http://example.test/auth',
						tokenUrl: 'http://example.test/token',
						scopes: [],
						clientIdEnv: 'TEST_CLIENT_ID',
						clientSecretEnv: 'TEST_CLIENT_SECRET',
					},
				},
			},
			customAuth: {
				getInstallUrl: () => 'http://example.test/auth',
				handleCallback: async () => ({ accessToken: 'fresh-token' }),
				getAccessToken: async () => 'fresh-token',
			},
			// Stable per-account ID, resolved the same way regardless of how many
			// times the account reconnects — the exact shape of Google Calendar's
			// resolveExternalId (account email).
			resolveExternalId: async () => stableExternalId,
		}
		vi.mocked(getProvider).mockReturnValue(testProvider)

		// Seed the already-active integration, as if a prior connect completed.
		const [existingActive] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: providerName,
				status: 'active',
				externalId: stableExternalId,
				credentials: encrypt(JSON.stringify({ accessToken: 'stale-token' })),
				createdBy: actorId,
			})
			.returning()

		// Seed the pending row the /connect step would have created for THIS attempt.
		const nonce = randomBytes(16).toString('hex')
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: providerName,
			status: 'pending',
			externalId: nonce,
			credentials: '',
			createdBy: actorId,
		})

		const state = encrypt(JSON.stringify({ workspaceId: ws.id, actorId, ts: Date.now(), nonce }))

		const app = buildApp()
		// Before the fix, this request would UPDATE the pending row's external_id to
		// stableExternalId, colliding with existingActive and returning 500.
		const res = await app.request(
			`/api/integrations/${providerName}/callback?state=${encodeURIComponent(state)}&code=irrelevant`,
			// The callback requires the state-binding cookie POST /connect sets; this
			// test seeds the pending row directly, so it supplies the cookie too.
			{ headers: { cookie: `maskin_oauth_nonce_${providerName}=${nonce}` } },
		)

		expect(res.status).toBe(302)

		const rows = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, ws.id), eq(integrations.provider, providerName)))

		// Exactly one row survives — the pending row was deleted, not promoted into
		// a duplicate that would violate the unique index.
		expect(rows).toHaveLength(1)
		expect(rows[0].id).toBe(existingActive.id)
		expect(rows[0].status).toBe('active')
		expect(rows[0].externalId).toBe(stableExternalId)
	})

	// Drive stamps config.first_tool_call_at on its first successful tool call and
	// the customer UI reads has-ingested from it. A disconnect leaves the row
	// revoked, and the reconnect refresh used to rewrite config from scratch, which
	// dropped the stamp and sent a connected workspace back to the first-call state.
	it('keeps config.first_tool_call_at when a revoked row is reconnected', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		const providerName = `test-stamped-provider-${randomBytes(4).toString('hex')}`
		const stableExternalId = 'stamped@example.com'
		const stamp = '2026-10-05T10:00:00.000Z'

		vi.mocked(getProvider).mockReturnValue({
			config: {
				name: providerName,
				displayName: `Test Stamped Provider ${providerName}`,
				auth: {
					type: 'oauth2',
					config: {
						authorizationUrl: 'http://example.test/auth',
						tokenUrl: 'http://example.test/token',
						scopes: [],
						clientIdEnv: 'TEST_CLIENT_ID',
						clientSecretEnv: 'TEST_CLIENT_SECRET',
					},
				},
			},
			customAuth: {
				getInstallUrl: () => 'http://example.test/auth',
				handleCallback: async () => ({ accessToken: 'fresh-token' }),
				getAccessToken: async () => 'fresh-token',
			},
			resolveExternalId: async () => stableExternalId,
		} satisfies ResolvedProvider)

		const [revoked] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: providerName,
				status: 'revoked',
				externalId: stableExternalId,
				credentials: encrypt(JSON.stringify({ accessToken: 'stale-token' })),
				config: { system_actor_id: 'old-system-actor', first_tool_call_at: stamp },
				createdBy: actorId,
			})
			.returning()

		const nonce = randomBytes(16).toString('hex')
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: providerName,
			status: 'pending',
			externalId: nonce,
			credentials: '',
			createdBy: actorId,
		})
		const state = encrypt(JSON.stringify({ workspaceId: ws.id, actorId, ts: Date.now(), nonce }))

		const res = await buildApp().request(
			`/api/integrations/${providerName}/callback?state=${encodeURIComponent(state)}&code=irrelevant`,
			{ headers: { cookie: `maskin_oauth_nonce_${providerName}=${nonce}` } },
		)
		expect(res.status).toBe(302)

		const [row] = await db.select().from(integrations).where(eq(integrations.id, revoked.id))
		expect(row.status).toBe('active')
		expect((row.config as Record<string, unknown>).first_tool_call_at).toBe(stamp)
		// The callback still owns the rest of config: the stale actor id is replaced.
		expect((row.config as Record<string, unknown>).system_actor_id).not.toBe('old-system-actor')
	})

	it('does not invent first_tool_call_at on a reconnect of a row that never had one', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		const providerName = `test-unstamped-provider-${randomBytes(4).toString('hex')}`
		const stableExternalId = 'unstamped@example.com'

		vi.mocked(getProvider).mockReturnValue({
			config: {
				name: providerName,
				displayName: `Test Unstamped Provider ${providerName}`,
				auth: {
					type: 'oauth2',
					config: {
						authorizationUrl: 'http://example.test/auth',
						tokenUrl: 'http://example.test/token',
						scopes: [],
						clientIdEnv: 'TEST_CLIENT_ID',
						clientSecretEnv: 'TEST_CLIENT_SECRET',
					},
				},
			},
			customAuth: {
				getInstallUrl: () => 'http://example.test/auth',
				handleCallback: async () => ({ accessToken: 'fresh-token' }),
				getAccessToken: async () => 'fresh-token',
			},
			resolveExternalId: async () => stableExternalId,
		} satisfies ResolvedProvider)

		const [revoked] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: providerName,
				status: 'revoked',
				externalId: stableExternalId,
				credentials: encrypt(JSON.stringify({ accessToken: 'stale-token' })),
				config: { system_actor_id: 'old-system-actor' },
				createdBy: actorId,
			})
			.returning()

		const nonce = randomBytes(16).toString('hex')
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: providerName,
			status: 'pending',
			externalId: nonce,
			credentials: '',
			createdBy: actorId,
		})
		const state = encrypt(JSON.stringify({ workspaceId: ws.id, actorId, ts: Date.now(), nonce }))

		const res = await buildApp().request(
			`/api/integrations/${providerName}/callback?state=${encodeURIComponent(state)}&code=irrelevant`,
			{ headers: { cookie: `maskin_oauth_nonce_${providerName}=${nonce}` } },
		)
		expect(res.status).toBe(302)

		const [row] = await db.select().from(integrations).where(eq(integrations.id, revoked.id))
		expect(row.status).toBe('active')
		expect(row.config as Record<string, unknown>).not.toHaveProperty('first_tool_call_at')
	})
})

// The same reconnect refresh also dropped config.drive.watchedFolders, emptying
// the customer's folder-watches list. The channel fields must not survive: the
// old channel was stopped at disconnect and postInstall opens a new one.
describe('GET /api/integrations/google-drive/callback — reconnect keeps the folder watches', () => {
	const GOOGLE_DRIVE = 'google-drive'
	const stamp = '2026-10-05T10:00:00.000Z'
	const watchedFolders = [
		{
			folderId: 'folder-a',
			name: 'Recordings',
			path: 'Team/Recordings',
			addedAt: '2026-10-01T09:00:00.000Z',
			lastFiredAt: '2026-10-08T12:30:00.000Z',
		},
		{
			folderId: 'folder-b',
			name: 'Contracts',
			addedAt: '2026-10-02T09:00:00.000Z',
			eventTypes: ['created', 'trashed'],
		},
	]
	const priorChannel = {
		channelId: 'old-channel-id',
		channelResourceId: 'old-resource-id',
		channelExpiresAt: 1_790_000_000_000,
		channelWebhookToken: 'old-webhook-token',
		startPageToken: 'old-page-token',
	}

	// Stands in for the Drive postInstall: records the row's drive block as the
	// callback left it, then writes fresh channel fields the way rotateChannel does.
	function driveProvider(
		accountEmail: string,
		seen?: { drive?: Record<string, unknown> },
	): ResolvedProvider {
		return {
			config: {
				name: GOOGLE_DRIVE,
				displayName: 'Google Drive',
				auth: {
					type: 'oauth2',
					config: {
						authorizationUrl: 'http://example.test/auth',
						tokenUrl: 'http://example.test/token',
						scopes: [],
						clientIdEnv: 'TEST_CLIENT_ID',
						clientSecretEnv: 'TEST_CLIENT_SECRET',
					},
				},
			},
			customAuth: {
				getInstallUrl: () => 'http://example.test/auth',
				handleCallback: async () => ({ accessToken: 'fresh-token' }),
				getAccessToken: async () => 'fresh-token',
			},
			resolveExternalId: async () => accountEmail,
			...(seen
				? {
						postInstall: async (ctx: PostInstallContext) => {
							const [row] = await db
								.select()
								.from(integrations)
								.where(eq(integrations.id, ctx.integrationId))
							seen.drive = (row.config as { drive?: Record<string, unknown> }).drive
							await mergeDriveConfig(db, ctx.integrationId, {
								channelId: 'new-channel-id',
								channelResourceId: 'new-resource-id',
								channelExpiresAt: 1_800_000_000_000,
								channelWebhookToken: 'new-webhook-token',
								startPageToken: 'new-page-token',
							})
						},
					}
				: {}),
		}
	}

	async function seedRevokedDriveRow(
		workspaceId: string,
		email: string,
		config: Record<string, unknown>,
	) {
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: GOOGLE_DRIVE,
				status: 'revoked',
				externalId: email,
				credentials: encrypt(JSON.stringify({ accessToken: 'stale-token' })),
				config,
				createdBy: getTestActorId(),
			})
			.returning()
		return row
	}

	async function reconnect(workspaceId: string) {
		const nonce = randomBytes(16).toString('hex')
		await db.insert(integrations).values({
			workspaceId,
			provider: GOOGLE_DRIVE,
			status: 'pending',
			externalId: nonce,
			credentials: '',
			createdBy: getTestActorId(),
		})
		const state = encrypt(
			JSON.stringify({ workspaceId, actorId: getTestActorId(), ts: Date.now(), nonce }),
		)
		return buildApp().request(
			`/api/integrations/${GOOGLE_DRIVE}/callback?state=${encodeURIComponent(state)}&code=irrelevant`,
			{ headers: { cookie: `maskin_oauth_nonce_${GOOGLE_DRIVE}=${nonce}` } },
		)
	}

	it('keeps both watchedFolders entries exactly and mints fresh channel fields', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const email = 'drive-watches@example.com'
		const seen: { drive?: Record<string, unknown> } = {}
		vi.mocked(getProvider).mockReturnValue(driveProvider(email, seen))
		const revoked = await seedRevokedDriveRow(ws.id, email, {
			system_actor_id: 'old-system-actor',
			first_tool_call_at: stamp,
			drive: { peopleId: 'people-1', ...priorChannel, watchedFolders },
		})

		const res = await reconnect(ws.id)
		expect(res.status).toBe(302)

		const [row] = await db.select().from(integrations).where(eq(integrations.id, revoked.id))
		expect(row.status).toBe('active')
		const config = row.config as { first_tool_call_at?: string; drive: Record<string, unknown> }
		expect(config.drive.watchedFolders).toEqual(watchedFolders)
		expect(config.first_tool_call_at).toBe(stamp)
		// What postInstall left behind is its own values, none of the prior row's.
		expect(config.drive).toMatchObject({
			channelId: 'new-channel-id',
			channelResourceId: 'new-resource-id',
			channelExpiresAt: 1_800_000_000_000,
			channelWebhookToken: 'new-webhook-token',
			startPageToken: 'new-page-token',
		})
		// Before postInstall ran, the callback had already dropped every channel field.
		expect(seen.drive).toEqual({ peopleId: 'people-1', watchedFolders })
	})

	it('does not invent a drive block on a reconnect of a row that had no watches', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const email = 'drive-no-watches@example.com'
		vi.mocked(getProvider).mockReturnValue(driveProvider(email))
		const revoked = await seedRevokedDriveRow(ws.id, email, {
			system_actor_id: 'old-system-actor',
			drive: { ...priorChannel },
		})

		const res = await reconnect(ws.id)
		expect(res.status).toBe(302)

		const [row] = await db.select().from(integrations).where(eq(integrations.id, revoked.id))
		expect(row.status).toBe('active')
		// Only channel fields were on the prior block, and none of them carry over.
		expect(row.config as Record<string, unknown>).not.toHaveProperty('drive')
	})

	it('does not hand another account its watchedFolders', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const accountA = await seedRevokedDriveRow(ws.id, 'account-a@example.com', {
			system_actor_id: 'old-system-actor',
			drive: { peopleId: 'people-a', watchedFolders },
		})
		vi.mocked(getProvider).mockReturnValue(driveProvider('account-b@example.com'))

		const res = await reconnect(ws.id)
		expect(res.status).toBe(302)

		const rows = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, ws.id), eq(integrations.provider, GOOGLE_DRIVE)))
		const accountB = rows.find((r) => r.externalId === 'account-b@example.com')
		expect(accountB?.status).toBe('active')
		expect(accountB?.config as Record<string, unknown>).not.toHaveProperty('drive')
		// Account A's row is untouched, still revoked and still holding its watches.
		const stillA = rows.find((r) => r.id === accountA.id)
		expect(stillA?.status).toBe('revoked')
		expect((stillA?.config as { drive: { watchedFolders: unknown } }).drive.watchedFolders).toEqual(
			watchedFolders,
		)
	})
})

// integration_connected must count real new connects only. A reconnect onto a
// row that was already active refreshes credentials in place but is not a new
// connect, so it must not emit a second event.
describe('GET /api/integrations/:provider/callback — integration_connected emit', () => {
	beforeEach(() => {
		vi.mocked(trackIntegrationConnected).mockClear()
	})

	const STABLE_EXTERNAL_ID = 'emit@example.com'

	async function runCallback(opts: {
		existingStatus?: 'active' | 'revoked' | 'error'
		postInstall?: () => Promise<void>
	}) {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const providerName = `test-emit-provider-${randomBytes(4).toString('hex')}`

		const testProvider: ResolvedProvider = {
			config: {
				name: providerName,
				displayName: `Test Emit Provider ${providerName}`,
				auth: {
					type: 'oauth2',
					config: {
						authorizationUrl: 'http://example.test/auth',
						tokenUrl: 'http://example.test/token',
						scopes: [],
						clientIdEnv: 'TEST_CLIENT_ID',
						clientSecretEnv: 'TEST_CLIENT_SECRET',
					},
				},
			},
			customAuth: {
				getInstallUrl: () => 'http://example.test/auth',
				handleCallback: async () => ({ accessToken: 'fresh-token' }),
				getAccessToken: async () => 'fresh-token',
			},
			resolveExternalId: async () => STABLE_EXTERNAL_ID,
			...(opts.postInstall ? { postInstall: opts.postInstall } : {}),
		}
		vi.mocked(getProvider).mockReturnValue(testProvider)

		if (opts.existingStatus) {
			await db.insert(integrations).values({
				workspaceId: ws.id,
				provider: providerName,
				status: opts.existingStatus,
				externalId: STABLE_EXTERNAL_ID,
				credentials: encrypt(JSON.stringify({ accessToken: 'stale-token' })),
				createdBy: actorId,
			})
		}

		const nonce = randomBytes(16).toString('hex')
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: providerName,
			status: 'pending',
			externalId: nonce,
			credentials: '',
			createdBy: actorId,
		})
		const state = encrypt(JSON.stringify({ workspaceId: ws.id, actorId, ts: Date.now(), nonce }))

		const res = await buildApp().request(
			`/api/integrations/${providerName}/callback?state=${encodeURIComponent(state)}&code=irrelevant`,
			{ headers: { cookie: `maskin_oauth_nonce_${providerName}=${nonce}` } },
		)
		return { res, providerName, workspaceId: ws.id }
	}

	it('emits exactly once on a first-time connect', async () => {
		const { res, providerName, workspaceId } = await runCallback({})

		expect(res.status).toBe(302)
		expect(trackIntegrationConnected).toHaveBeenCalledTimes(1)
		expect(trackIntegrationConnected).toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerName, workspaceId, authType: 'oauth' }),
		)
	})

	it('does not emit when reconnecting onto an already-active row, but still refreshes it', async () => {
		const { res, providerName, workspaceId } = await runCallback({ existingStatus: 'active' })

		expect(res.status).toBe(302)
		expect(trackIntegrationConnected).not.toHaveBeenCalled()

		const rows = await db
			.select()
			.from(integrations)
			.where(
				and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, providerName)),
			)
		expect(rows).toHaveLength(1)
		expect(rows[0].status).toBe('active')
		expect(JSON.parse(decrypt(rows[0].credentials))).toMatchObject({ accessToken: 'fresh-token' })
	})

	it.each(['revoked', 'error'] as const)(
		'emits exactly once when reconnecting onto a %s row',
		async (existingStatus) => {
			const { res } = await runCallback({ existingStatus })

			expect(res.status).toBe(302)
			expect(trackIntegrationConnected).toHaveBeenCalledTimes(1)
		},
	)

	it('emits nothing when postInstall fails', async () => {
		const { res } = await runCallback({
			postInstall: async () => {
				throw new Error('postInstall boom')
			},
		})

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toContain('error=post_install_failed')
		expect(trackIntegrationConnected).not.toHaveBeenCalled()
	})
})
