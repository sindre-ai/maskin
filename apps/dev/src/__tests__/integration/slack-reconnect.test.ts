import { randomBytes } from 'node:crypto'
import { integrations, triggers, workspaceMembers } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SLACK_DEFAULT_TRIGGER_MARKER } from '../../lib/integrations/providers/slack/default-triggers'
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
function mockSlackOAuthFetch(teamId: string) {
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
		const u = typeof url === 'string' ? url : url.toString()
		if (u.includes('oauth.v2.access')) {
			return {
				ok: true,
				json: async () => ({
					ok: true,
					access_token: `xoxb-${randomBytes(6).toString('hex')}`,
					token_type: 'bot',
					scope: 'chat:write,app_mentions:read',
					team: { id: teamId, name: 'Test Team' },
					bot_user_id: 'U-bot',
					app_id: 'A-test',
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

	return app.request(
		`http://localhost/api/integrations/slack/callback?code=test-code&state=${encodeURIComponent(state as string)}`,
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
	let observerId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		// The default-trigger seeding targets the bootstrap observer agent.
		const observer = await insertActor(db, { type: 'agent', name: 'Workspace Observer' })
		observerId = observer.id
		await db.insert(workspaceMembers).values({
			workspaceId,
			actorId: observerId,
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
		// the Workspace Observer agent.
		const seededAfterConnect = await seededTriggers(workspaceId)
		expect(seededAfterConnect).toHaveLength(2)
		expect(
			new Set(seededAfterConnect.map((t) => (t.config as { entity_type: string }).entity_type)),
		).toEqual(new Set(['slack.direct_message', 'slack.app_mention']))
		for (const trigger of seededAfterConnect) {
			expect(trigger.targetActorId).toBe(observerId)
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
})
