import { randomBytes } from 'node:crypto'
import { integrations, triggers, workspaceMembers } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decrypt } from '../../lib/crypto'
import { config as slackProviderConfig } from '../../lib/integrations/providers/slack/config'
import { SLACK_DEFAULT_TRIGGER_MARKER } from '../../lib/integrations/providers/slack/default-triggers'
import type { StoredCredentials } from '../../lib/integrations/types'
import { insertActor, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: integrationsRoutes } = await import('../../routes/integrations')

// Integration coverage for the OAuth connect → disconnect → reconnect
// lifecycle against real Postgres. The partial unique index
// `integrations_ws_provider_external_uniq` on (workspace_id, provider,
// external_id) has no status filter, so a disconnect (status='revoked')
// used to permanently block re-activation of the same Slack team with a
// 23505 — the callback's refresh branch only covered
// `credentials.installation_id` providers (GitHub), never Slack's
// resolveExternalId-derived team ids. These tests pin the fixed behavior:
// reconnect reactivates the existing row in place, whatever its status.
//
// Slack's token exchange and tier probe are mocked at the global fetch
// boundary; everything DB-side runs against the real schema + migrations.

const TEST_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
	for (const key of ['INTEGRATION_ENCRYPTION_KEY', 'SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET']) {
		savedEnv[key] = process.env[key]
	}
	process.env.INTEGRATION_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY
	process.env.SLACK_CLIENT_ID = 'test-client-id'
	process.env.SLACK_CLIENT_SECRET = 'test-client-secret'
})

afterAll(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			Reflect.deleteProperty(process.env, key)
		} else {
			process.env[key] = value
		}
	}
})

beforeEach(() => {
	vi.restoreAllMocks()
})

/**
 * Mock Slack's HTTP surface for the OAuth callback path:
 *  - oauth.v2.access → token response carrying `team.id`, which
 *    parseTokenResponse stashes so resolveExternalId never needs auth.test
 *  - apps.permissions.info → not-ok, so the postInstall tier probe records
 *    'unknown' and proceeds (fail-open by design)
 */
/** The user scopes the provider config actually asks Slack for. */
const REQUESTED_USER_SCOPE =
	slackProviderConfig.auth.type === 'oauth2'
		? (slackProviderConfig.auth.config.extraAuthParams?.user_scope ?? '')
		: ''

function mockSlackOAuthFetch(
	teamId: string,
	opts: { userToken?: string | null; scope?: string; userScope?: string } = {},
) {
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
		const u = typeof url === 'string' ? url : url.toString()
		if (u.includes('oauth.v2.access')) {
			// Slack returns the bot token as `access_token` and the installer's
			// user token under `authed_user` — both from the one exchange, which is
			// what lets a single reconnect grant both. `userToken: null` models an
			// install that predates the `user_scope` grant.
			const userToken =
				opts.userToken === null
					? undefined
					: (opts.userToken ?? `xoxp-${randomBytes(6).toString('hex')}`)
			return {
				ok: true,
				json: async () => ({
					ok: true,
					access_token: `xoxb-${randomBytes(6).toString('hex')}`,
					token_type: 'bot',
					scope: opts.scope ?? 'chat:write,app_mentions:read',
					team: { id: teamId, name: 'Test Team' },
					bot_user_id: 'U-bot',
					app_id: 'A-test',
					authed_user: {
						id: 'U-installer',
						...(userToken
							? {
									access_token: userToken,
									// Mirror what the config asks for, so a change to the
									// requested user scopes doesn't leave this mock granting a
									// scope name the product no longer uses.
									scope: opts.userScope ?? REQUESTED_USER_SCOPE,
								}
							: {}),
					},
				}),
			} as unknown as Response
		}
		if (u.includes('apps.permissions.info')) {
			return {
				ok: true,
				json: async () => ({ ok: false, error: 'not_allowed_token_type' }),
			} as unknown as Response
		}
		throw new Error(`unexpected fetch in test: ${u}`)
	})
}

function createApp() {
	return createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
}

/** Run POST /connect and drive the returned state through GET /callback. */
async function connectAndCallback(
	app: ReturnType<typeof createApp>,
	workspaceId: string,
): Promise<Response> {
	const connectRes = await app.request(
		new Request('http://localhost/api/integrations/slack/connect', {
			method: 'POST',
			headers: { 'X-Workspace-Id': workspaceId, 'Content-Type': 'application/json' },
		}),
	)
	expect(connectRes.status).toBe(200)
	const { install_url: installUrl } = (await connectRes.json()) as { install_url: string }
	const state = new URL(installUrl).searchParams.get('state')
	expect(state).toBeTruthy()

	// Carry the state-binding cookie across, exactly as the browser does. The
	// callback rejects a state it did not hand this client, so this is part of
	// the flow under test rather than test scaffolding.
	const bindingCookie = (connectRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? ''
	expect(bindingCookie).toContain('maskin_oauth_nonce_slack=')

	return app.request(
		`http://localhost/api/integrations/slack/callback?code=test-code&state=${encodeURIComponent(state as string)}`,
		{ headers: { cookie: bindingCookie } },
	)
}

async function slackRowsForTeam(workspaceId: string, teamId: string) {
	return db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, 'slack'),
				eq(integrations.externalId, teamId),
			),
		)
}

async function seededTriggers(workspaceId: string) {
	return db
		.select()
		.from(triggers)
		.where(
			and(
				eq(triggers.workspaceId, workspaceId),
				sql`${triggers.metadata}->>'seeded_by' = ${SLACK_DEFAULT_TRIGGER_MARKER}`,
			),
		)
}

describe('Slack OAuth reconnect lifecycle (integration)', () => {
	let workspaceId: string
	let teamId: string
	let driverId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		// The default-trigger seeding targets the Workspace Driver agent.
		const driver = await insertActor(db, { type: 'agent', name: 'Workspace Driver' })
		driverId = driver.id
		await db.insert(workspaceMembers).values({
			workspaceId,
			actorId: driverId,
			role: 'member',
		})
		teamId = `T${randomBytes(4).toString('hex').toUpperCase()}`
		mockSlackOAuthFetch(teamId)
	})

	it('connect → disconnect → reconnect reactivates the revoked row instead of 23505ing', async () => {
		const app = createApp()

		// First connect activates a row keyed on the Slack team id.
		const firstCallback = await connectAndCallback(app, workspaceId)
		expect(firstCallback.status).toBe(302)
		const [firstRow] = await slackRowsForTeam(workspaceId, teamId)
		expect(firstRow).toBeDefined()
		expect(firstRow?.status).toBe('active')

		// postInstall seeded the default mention/DM responder triggers targeting
		// the Workspace Driver agent.
		const seededAfterConnect = await seededTriggers(workspaceId)
		expect(seededAfterConnect).toHaveLength(2)
		expect(
			new Set(seededAfterConnect.map((t) => (t.config as { entity_type: string }).entity_type)),
		).toEqual(new Set(['slack.direct_message', 'slack.app_mention']))
		for (const trigger of seededAfterConnect) {
			expect(trigger.targetActorId).toBe(driverId)
			expect(trigger.enabled).toBe(true)
		}

		// Disconnect soft-deletes: the row stays, flipped to 'revoked'.
		const deleteRes = await app.request(
			new Request(`http://localhost/api/integrations/${firstRow?.id}`, {
				method: 'DELETE',
				headers: { 'X-Workspace-Id': workspaceId },
			}),
		)
		expect(deleteRes.status).toBe(200)
		const [revokedRow] = await slackRowsForTeam(workspaceId, teamId)
		expect(revokedRow?.status).toBe('revoked')

		// preDisconnect removed the seeded triggers with the integration.
		expect(await seededTriggers(workspaceId)).toHaveLength(0)

		// Reconnect must succeed and reactivate the same row — this returned a
		// 500 (unique constraint 23505) before the fix.
		const secondCallback = await connectAndCallback(app, workspaceId)
		expect(secondCallback.status).toBe(302)

		// Reconnect re-seeds the defaults.
		expect(await seededTriggers(workspaceId)).toHaveLength(2)

		const rowsAfter = await slackRowsForTeam(workspaceId, teamId)
		expect(rowsAfter).toHaveLength(1)
		expect(rowsAfter[0]?.id).toBe(firstRow?.id)
		expect(rowsAfter[0]?.status).toBe('active')
		// Credentials were refreshed by the reconnect.
		expect(rowsAfter[0]?.credentials).not.toBe(firstRow?.credentials)

		// The reconnect's pending nonce row was cleaned up, not orphaned.
		const pendingRows = await db
			.select()
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.provider, 'slack'),
					eq(integrations.status, 'pending'),
				),
			)
		expect(pendingRows).toHaveLength(0)
	})

	it('reconnecting while still active refreshes the row in place', async () => {
		const app = createApp()

		const firstCallback = await connectAndCallback(app, workspaceId)
		expect(firstCallback.status).toBe(302)
		const [firstRow] = await slackRowsForTeam(workspaceId, teamId)
		expect(firstRow?.status).toBe('active')

		const secondCallback = await connectAndCallback(app, workspaceId)
		expect(secondCallback.status).toBe(302)

		const rowsAfter = await slackRowsForTeam(workspaceId, teamId)
		expect(rowsAfter).toHaveLength(1)
		expect(rowsAfter[0]?.id).toBe(firstRow?.id)
		expect(rowsAfter[0]?.status).toBe('active')
		expect(rowsAfter[0]?.credentials).not.toBe(firstRow?.credentials)

		// Seeding is idempotent: reconnecting while active must not duplicate the
		// default triggers.
		expect(await seededTriggers(workspaceId)).toHaveLength(2)
	})

	// Slack returns the bot and user tokens from one exchange, and the reconnect
	// branch above replaces the credentials blob WHOLESALE (matched on the stable
	// team id). So the user token can never be merged in from a previous blob —
	// if it did not arrive in this exchange, it is gone. Pin that it survives.
	it('persists the user token from authed_user through a reconnect', async () => {
		const app = createApp()

		expect((await connectAndCallback(app, workspaceId)).status).toBe(302)
		const [firstRow] = await slackRowsForTeam(workspaceId, teamId)
		const firstCreds = JSON.parse(decrypt(firstRow?.credentials as string)) as StoredCredentials
		expect(firstCreds.accessToken).toMatch(/^xoxb-/)
		expect(firstCreds.userAccessToken).toMatch(/^xoxp-/)
		expect(firstCreds.userScope).toBe(REQUESTED_USER_SCOPE)
		expect(firstCreds.authedUserId).toBe('U-installer')

		// Reconnect with a known user token and confirm it replaced the old one
		// rather than being dropped or stale-carried.
		vi.restoreAllMocks()
		mockSlackOAuthFetch(teamId, { userToken: 'xoxp-second-install' })
		expect((await connectAndCallback(app, workspaceId)).status).toBe(302)

		const [secondRow] = await slackRowsForTeam(workspaceId, teamId)
		expect(secondRow?.id).toBe(firstRow?.id)
		const secondCreds = JSON.parse(decrypt(secondRow?.credentials as string)) as StoredCredentials
		expect(secondCreds.userAccessToken).toBe('xoxp-second-install')
		// The bot token must still be the BOT token — the xoxb- guards key off it.
		expect(secondCreds.accessToken).toMatch(/^xoxb-/)
	})

	// An install that predates the user_scope grant: Slack sends authed_user with
	// an id but no token. The bot half must still work; only search is withheld.
	it('stores no user token when the install did not grant one', async () => {
		vi.restoreAllMocks()
		mockSlackOAuthFetch(teamId, { userToken: null })
		const app = createApp()

		expect((await connectAndCallback(app, workspaceId)).status).toBe(302)
		const [row] = await slackRowsForTeam(workspaceId, teamId)
		const creds = JSON.parse(decrypt(row?.credentials as string)) as StoredCredentials
		expect(creds.accessToken).toMatch(/^xoxb-/)
		expect(creds.userAccessToken).toBeUndefined()
	})

	// The reconnect prompt's data source. A token granted before the history and
	// search scopes were added is still `active` and still works for what it was
	// granted — the list endpoint is what tells a human it needs re-consent.
	it('reports scope drift on GET /api/integrations for a stale install', async () => {
		vi.restoreAllMocks()
		// Only the two scopes the phase-1 install carried.
		mockSlackOAuthFetch(teamId, { userToken: null, scope: 'chat:write,app_mentions:read' })
		const app = createApp()
		expect((await connectAndCallback(app, workspaceId)).status).toBe(302)

		const listRes = await app.request(
			new Request('http://localhost/api/integrations', {
				headers: { 'X-Workspace-Id': workspaceId },
			}),
		)
		expect(listRes.status).toBe(200)
		const rows = (await listRes.json()) as {
			provider: string
			missingScopes?: string[]
			needsReconnect?: boolean
		}[]
		const slackRow = rows.find((r) => r.provider === 'slack')

		expect(slackRow?.needsReconnect).toBe(true)
		expect(slackRow?.missingScopes).toEqual(
			expect.arrayContaining(['channels:history', 'groups:history', 'search:read.public']),
		)
		// Scope NAMES only — a token must never ride along in the list response.
		expect(JSON.stringify(slackRow)).not.toContain('xoxb-')
	})

	it('reports no scope drift for an install that granted everything', async () => {
		vi.restoreAllMocks()
		if (slackProviderConfig.auth.type !== 'oauth2') throw new Error('unreachable')
		// Grant exactly what the config asks for, on both halves of the grant.
		mockSlackOAuthFetch(teamId, {
			scope: slackProviderConfig.auth.config.scopes.join(','),
			userScope: REQUESTED_USER_SCOPE,
		})
		const app = createApp()
		expect((await connectAndCallback(app, workspaceId)).status).toBe(302)

		const listRes = await app.request(
			new Request('http://localhost/api/integrations', {
				headers: { 'X-Workspace-Id': workspaceId },
			}),
		)
		const rows = (await listRes.json()) as {
			provider: string
			missingScopes?: string[]
			needsReconnect?: boolean
		}[]
		const slackRow = rows.find((r) => r.provider === 'slack')
		expect(slackRow?.missingScopes).toEqual([])
		expect(slackRow?.needsReconnect).toBe(false)
	})
})
