import { createHmac, randomBytes } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	integrations,
	slackUserLinks,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { createMockStorageProvider } from '../setup'
import { db, getTestActorId, sql } from './global-setup'

// AC-U1 + AC-T2 coverage for the DM-vs-channel identity split.
//
// The route splits inbound Slack mentions two ways:
//  - DM: routes ONLY to the mentioning Slack user's `slack_user_links` row's
//    workspace. No link → drop the event and post the AC-U5 re-link picker.
//  - Channel: routes to every workspace bound to the Slack team, ignoring the
//    mentioning user's DM link.
//
// The three integration tests below match the three cases the T11 brief
// asserts: (a) channel does not load personal, (b) DM does not load
// channel-bound, (c) DM-with-no-link fires the re-link picker instead of
// silently dispatching to any workspace.

const SIGNING_SECRET = 'test-slack-signing-secret-T11'

const TEST_ENCRYPTION_KEY = randomBytes(32).toString('hex')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		storageProvider: StorageProvider
	}
}

function signSlackBody(body: string, timestamp: string): string {
	return `v0=${createHmac('sha256', SIGNING_SECRET)
		.update(`v0:${timestamp}:${body}`)
		.digest('hex')}`
}

async function buildSignedSlackWebhook(body: Record<string, unknown>) {
	const raw = JSON.stringify(body)
	const timestamp = String(Math.floor(Date.now() / 1000))
	return new Request('http://localhost/api/webhooks/slack', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-slack-signature': signSlackBody(raw, timestamp),
			'x-slack-request-timestamp': timestamp,
		},
		body: raw,
	})
}

async function createWebhookApp(storage: StorageProvider) {
	const { webhookApp } = await import('../../routes/integrations')
	const app = new OpenAPIHono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('storageProvider', storage)
		await next()
	})
	app.route('/api/webhooks', webhookApp)
	return app
}

// Slack ingest runs `asyncProcessing: true` — the route acks before the
// fan-out + events insert finishes. The background work is genuine Postgres
// I/O spanning many event-loop turns, so a fixed-tick `setImmediate` yield
// isn't enough; await the route's own tracked in-flight promises instead.
async function flushAsyncProcessing(): Promise<void> {
	const { __flushAsyncWebhookProcessingForTests } = await import('../../routes/integrations')
	await __flushAsyncWebhookProcessingForTests()
}

interface FakeSlackFetchState {
	usersInfoCalls: number
	postEphemeralCalls: Array<{ channel: string; user: string }>
}

/**
 * Fake global fetch that answers just enough of Slack's Web API for the
 * account-link picker path to run: users.info returns a stub actor, and
 * chat.postEphemeral is captured so tests can assert the picker was posted.
 * Any other outbound call throws so an accidental network dependency fails
 * loud instead of silently escaping.
 */
function installSlackFetchStub(email: string | null): FakeSlackFetchState {
	const state: FakeSlackFetchState = { usersInfoCalls: 0, postEphemeralCalls: [] }
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const url = typeof input === 'string' ? input : input.toString()
		if (url.includes('slack.com/api/users.info')) {
			state.usersInfoCalls++
			return {
				ok: true,
				json: async () => ({
					ok: true,
					user: { id: 'U_DM_USER', is_bot: false, profile: email ? { email } : {} },
				}),
			} as unknown as Response
		}
		if (url.includes('slack.com/api/chat.postEphemeral')) {
			const bodyStr = typeof init?.body === 'string' ? init.body : (init?.body?.toString?.() ?? '')
			let parsed: Record<string, unknown> = {}
			try {
				parsed = JSON.parse(bodyStr) as Record<string, unknown>
			} catch {
				parsed = {}
			}
			state.postEphemeralCalls.push({
				channel: typeof parsed.channel === 'string' ? parsed.channel : '',
				user: typeof parsed.user === 'string' ? parsed.user : '',
			})
			return {
				ok: true,
				json: async () => ({ ok: true, message_ts: '1.2' }),
			} as unknown as Response
		}
		throw new Error(`unexpected fetch in slack-identity-split test: ${url}`)
	})
	return state
}

async function insertActor(email: string): Promise<string> {
	const [actor] = await sql`
		INSERT INTO actors (type, name, email, api_key)
		VALUES ('human', 'Split Actor', ${email}, ${`ank_${randomBytes(8).toString('hex')}`})
		RETURNING id
	`
	return actor.id
}

async function insertWorkspaceWithSlack(args: {
	name: string
	teamId: string
	memberActorId: string
}): Promise<{ workspaceId: string; integrationId: string }> {
	const testActorId = getTestActorId()
	const [ws] = await db
		.insert(workspaces)
		.values({ name: args.name, createdBy: testActorId })
		.returning()
	if (!ws) throw new Error('workspace insert failed')
	await db.insert(workspaceMembers).values({
		workspaceId: ws.id,
		actorId: args.memberActorId,
		role: 'owner',
	})
	// Second row so the acting linking actor is a member too, without touching
	// the ownership row above. Owner + member on the same workspace is fine.
	if (args.memberActorId !== testActorId) {
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: testActorId, role: 'admin' })
	}
	const encryptedCreds = encrypt(JSON.stringify({ accessToken: 'xoxb-fake-token-for-t11' }))
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId: ws.id,
			provider: 'slack',
			status: 'active',
			externalId: args.teamId,
			credentials: encryptedCreds,
			config: { system_actor_id: testActorId },
			createdBy: testActorId,
		})
		.returning()
	if (!row) throw new Error('integration insert failed')
	return { workspaceId: ws.id, integrationId: row.id }
}

async function eventCount(workspaceId: string, entityType: string): Promise<number> {
	const rows = await db
		.select({ id: events.id })
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, entityType)))
	return rows.length
}

describe('Slack identity split — DM vs channel dispatch (T11 / AC-U1 + AC-T2)', () => {
	let prevSecret: string | undefined
	let prevEncryption: string | undefined
	let nonce = 0

	beforeAll(() => {
		prevSecret = process.env.SLACK_SIGNING_SECRET
		prevEncryption = process.env.INTEGRATION_ENCRYPTION_KEY
		process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET
		process.env.INTEGRATION_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY
	})

	afterAll(() => {
		if (prevSecret === undefined) process.env.SLACK_SIGNING_SECRET = undefined
		else process.env.SLACK_SIGNING_SECRET = prevSecret
		if (prevEncryption === undefined) {
			Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')
		} else {
			process.env.INTEGRATION_ENCRYPTION_KEY = prevEncryption
		}
	})

	beforeEach(() => {
		vi.restoreAllMocks()
	})

	// AC-T2 assertion (a): a channel mention from a user who has a personal
	// DM link does NOT load that user's personal workspace connectors. The
	// channel surface routes purely off the Slack team's `integrations` rows,
	// so both bound workspaces get the event even though the user's personal
	// link only points at one of them.
	it('channel mention with a linked user still fans out to every channel-bound workspace, not just the personal link', async () => {
		const linkedActorId = await insertActor(`t11-channel-${++nonce}@test.local`)
		const teamId = `T_CH_${nonce}`
		const personal = await insertWorkspaceWithSlack({
			name: `personal-${nonce}`,
			teamId,
			memberActorId: linkedActorId,
		})
		const other = await insertWorkspaceWithSlack({
			name: `other-${nonce}`,
			teamId,
			memberActorId: linkedActorId,
		})
		await db.insert(slackUserLinks).values({
			slackTeamId: teamId,
			slackUserId: 'U_CH_USER',
			actorId: linkedActorId,
			defaultWorkspaceId: personal.workspaceId,
		})

		installSlackFetchStub(null)
		const app = await createWebhookApp(createMockStorageProvider())
		const req = await buildSignedSlackWebhook({
			type: 'event_callback',
			team_id: teamId,
			event_id: `Ev_T11_CH_${nonce}`,
			event: {
				type: 'app_mention',
				channel: 'C_PUBLIC_CH',
				channel_type: 'channel',
				user: 'U_CH_USER',
				text: '<@UMASKIN> hi channel',
			},
		})

		const res = await app.request(req)
		expect(res.status).toBe(200)
		await flushAsyncProcessing()

		expect(await eventCount(personal.workspaceId, 'slack.app_mention')).toBe(1)
		expect(await eventCount(other.workspaceId, 'slack.app_mention')).toBe(1)
	})

	// AC-T2 assertion (b): a DM from a user who has a personal link ONLY
	// lands in that user's linked workspace. The other Maskin workspace also
	// bound to the same Slack team must never see the DM, even though it
	// would receive a channel mention from the same user.
	it('DM from a linked user lands only in the personal workspace, not in the other bound workspace', async () => {
		const linkedActorId = await insertActor(`t11-dm-${++nonce}@test.local`)
		const teamId = `T_DM_${nonce}`
		const personal = await insertWorkspaceWithSlack({
			name: `personal-${nonce}`,
			teamId,
			memberActorId: linkedActorId,
		})
		const other = await insertWorkspaceWithSlack({
			name: `other-${nonce}`,
			teamId,
			memberActorId: linkedActorId,
		})
		await db.insert(slackUserLinks).values({
			slackTeamId: teamId,
			slackUserId: 'U_DM_USER',
			actorId: linkedActorId,
			defaultWorkspaceId: personal.workspaceId,
		})

		installSlackFetchStub(null)
		const app = await createWebhookApp(createMockStorageProvider())
		const req = await buildSignedSlackWebhook({
			type: 'event_callback',
			team_id: teamId,
			event_id: `Ev_T11_DM_${nonce}`,
			event: {
				type: 'message',
				channel: 'D_DM_CH',
				user: 'U_DM_USER',
				text: 'sup',
			},
		})

		const res = await app.request(req)
		expect(res.status).toBe(200)
		await flushAsyncProcessing()

		expect(await eventCount(personal.workspaceId, 'slack.direct_message')).toBe(1)
		expect(await eventCount(other.workspaceId, 'slack.direct_message')).toBe(0)
	})

	// AC-T2 assertion (c): a DM from a Slack user with no personal link
	// triggers the AC-U5 re-link picker instead of silently falling back to
	// the channel-bound / installer workspace. No event lands anywhere; the
	// user must pick a workspace explicitly.
	it('DM from an unlinked user triggers the re-link picker and does NOT dispatch to any workspace', async () => {
		const unrelatedActorId = await insertActor(`t11-unlinked-${++nonce}@test.local`)
		const teamId = `T_UNLINKED_${nonce}`
		const bound = await insertWorkspaceWithSlack({
			name: `bound-${nonce}`,
			teamId,
			memberActorId: unrelatedActorId,
		})

		const state = installSlackFetchStub(null)
		const app = await createWebhookApp(createMockStorageProvider())
		const req = await buildSignedSlackWebhook({
			type: 'event_callback',
			team_id: teamId,
			event_id: `Ev_T11_UNLINKED_${nonce}`,
			event: {
				type: 'message',
				channel: 'D_DM_NL',
				user: 'U_NO_LINK',
				text: 'hi',
			},
		})

		const res = await app.request(req)
		expect(res.status).toBe(200)
		await flushAsyncProcessing()
		// The prompt path fires from the route as a fire-and-forget promise;
		// yield once more to let its awaits resolve before asserting fetch.
		await flushAsyncProcessing()

		expect(await eventCount(bound.workspaceId, 'slack.direct_message')).toBe(0)
		// re-link picker was posted via chat.postEphemeral back to the DM
		expect(state.postEphemeralCalls.length).toBeGreaterThanOrEqual(1)
		expect(state.postEphemeralCalls[0]?.channel).toBe('D_DM_NL')
		expect(state.postEphemeralCalls[0]?.user).toBe('U_NO_LINK')
	})
})
