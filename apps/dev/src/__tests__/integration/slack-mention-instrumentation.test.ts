import { createHmac } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, integrations, workspaceMembers, workspaces } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createMockStorageProvider } from '../setup'
import { db, getTestActorId } from './global-setup'

// Mock the PostHog capture so the metric emit is observable without sending
// an HTTP request. The route's tag/emit helper still runs end-to-end.
const capturePosthogMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogMock,
}))

import {
	__resetSlackAttributionForTests,
	consumeSlackAttribution,
} from '../../lib/analytics/slack-attribution'
import { __resetSlackMentionDedupForTests } from '../../lib/analytics/slack-mention-dedup'

const SIGNING_SECRET = 'test-slack-signing-secret'

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
	const digest = createHmac('sha256', SIGNING_SECRET)
		.update(`v0:${timestamp}:${body}`)
		.digest('hex')
	return `v0=${digest}`
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
// fan-out + events insert finishes. Yield once so the chained microtasks
// settle before we assert DB state.
function flushAsyncProcessing(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve))
}

describe('Slack mention instrumentation — webhook round-trip', () => {
	let workspaceId: string
	let prevSecret: string | undefined
	let nonce = 0

	beforeAll(() => {
		prevSecret = process.env.SLACK_SIGNING_SECRET
		process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET
	})

	afterAll(() => {
		if (prevSecret === undefined) process.env.SLACK_SIGNING_SECRET = undefined
		else process.env.SLACK_SIGNING_SECRET = prevSecret
	})

	beforeEach(async () => {
		__resetSlackAttributionForTests()
		__resetSlackMentionDedupForTests()
		capturePosthogMock.mockClear()

		const actorId = getTestActorId()
		const [ws] = await db
			.insert(workspaces)
			.values({ name: 'Slack mention test', createdBy: actorId })
			.returning()
		if (!ws) throw new Error('workspace insert failed')
		workspaceId = ws.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId, role: 'owner' })
		await db.insert(integrations).values({
			workspaceId,
			provider: 'slack',
			status: 'active',
			externalId: 'T_INTEGRATION',
			credentials: 'encrypted',
			config: { system_actor_id: actorId },
			createdBy: actorId,
		})
	})

	// Round-trip evidence for T8's DoD: a real signed Slack app_mention hits the
	// route, lands an events row with `source: 'slack_mention'` in JSONB, the
	// PostHog ship-metric capture is called once, and the attribution window
	// opens for downstream writers to inherit.
	it('tags the events row with source: slack_mention, opens the attribution window, and emits the ship metric', async () => {
		const app = await createWebhookApp(createMockStorageProvider())
		const req = await buildSignedSlackWebhook({
			type: 'event_callback',
			team_id: 'T_INTEGRATION',
			event_id: `Ev_T8_HAPPY_${++nonce}`,
			event: {
				type: 'app_mention',
				channel: 'C_PUBLIC',
				user: 'U_SLACK_USER',
				text: '<@UMASKIN> what is the status of bet/slack-app',
			},
		})

		const res = await app.request(req)
		expect(res.status).toBe(200)
		await flushAsyncProcessing()

		const rows = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'slack.app_mention')))
		expect(rows).toHaveLength(1)
		const row = rows[0]
		const data = row?.data as Record<string, unknown>
		expect(data.source).toBe('slack_mention')

		expect(consumeSlackAttribution(workspaceId)).toBe(true)

		expect(capturePosthogMock).toHaveBeenCalledOnce()
		expect(capturePosthogMock).toHaveBeenCalledWith('slack_mention_received', workspaceId, {
			workspace_id: workspaceId,
			actor_id: getTestActorId(),
			channel_type: 'channel',
			agent: 'workspace_coach',
			slack_team_id: 'T_INTEGRATION',
		})
	})

	// A direct message to the bot should also count as a mention for the ship
	// metric — channel_type carries 'im' so the analytics side can split.
	it('reports channel_type: im for DM ingest and tags the DM event row', async () => {
		const app = await createWebhookApp(createMockStorageProvider())
		const req = await buildSignedSlackWebhook({
			type: 'event_callback',
			team_id: 'T_INTEGRATION',
			event_id: `Ev_T8_DM_${++nonce}`,
			event: {
				type: 'message',
				channel: 'D_DM',
				user: 'U_SLACK_USER',
				text: 'sup',
			},
		})

		const res = await app.request(req)
		expect(res.status).toBe(200)
		await flushAsyncProcessing()

		const rows = await db
			.select()
			.from(events)
			.where(
				and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'slack.direct_message')),
			)
		expect(rows).toHaveLength(1)
		expect((rows[0]?.data as Record<string, unknown>).source).toBe('slack_mention')

		expect(capturePosthogMock).toHaveBeenCalledWith(
			'slack_mention_received',
			workspaceId,
			expect.objectContaining({ channel_type: 'im' }),
		)
	})

	// Paired-envelope dedup: when a human DMs `@Maskin`, Slack delivers both
	// `app_mention` and `message` (channel `D…`, normalized to
	// `slack.direct_message`) with the same `client_msg_id`. Two distinct
	// webhook envelopes, two distinct `event_id`s — the per-delivery
	// `emittedOnce` guard can't see across them, so without this dedup
	// DMs would double-count and bias the bet's downstream-conversion ratio.
	it('emits the ship metric exactly once for paired app_mention + message.im envelopes', async () => {
		const app = await createWebhookApp(createMockStorageProvider())
		const clientMsgId = `cmid_${++nonce}`
		const ts = `1700000000.0000${nonce}`

		// First envelope: app_mention. Slack delivers this for any channel,
		// including DMs — the channel prefix is the only DM tell.
		const appMentionReq = await buildSignedSlackWebhook({
			type: 'event_callback',
			team_id: 'T_INTEGRATION',
			event_id: `Ev_DEDUP_AM_${nonce}`,
			event: {
				type: 'app_mention',
				channel: 'D_DM',
				user: 'U_SLACK_USER',
				text: '<@UMASKIN> please help',
				client_msg_id: clientMsgId,
				ts,
			},
		})
		const res1 = await app.request(appMentionReq)
		expect(res1.status).toBe(200)
		await flushAsyncProcessing()

		// Second envelope: the paired message.im, same client_msg_id.
		const dmReq = await buildSignedSlackWebhook({
			type: 'event_callback',
			team_id: 'T_INTEGRATION',
			event_id: `Ev_DEDUP_DM_${nonce}`,
			event: {
				type: 'message',
				channel: 'D_DM',
				user: 'U_SLACK_USER',
				text: '<@UMASKIN> please help',
				client_msg_id: clientMsgId,
				ts,
			},
		})
		const res2 = await app.request(dmReq)
		expect(res2.status).toBe(200)
		await flushAsyncProcessing()

		// Both event rows land (the tag for downstream attribution belongs on
		// each — only the metric emit is deduped).
		const appMentionRows = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'slack.app_mention')))
		const dmRows = await db
			.select()
			.from(events)
			.where(
				and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'slack.direct_message')),
			)
		expect(appMentionRows).toHaveLength(1)
		expect(dmRows).toHaveLength(1)
		expect((appMentionRows[0]?.data as Record<string, unknown>).source).toBe('slack_mention')
		expect((dmRows[0]?.data as Record<string, unknown>).source).toBe('slack_mention')

		// PostHog ship metric fired exactly once across the paired envelopes,
		// and channel_type is `im` (the app_mention's channel prefix tells the
		// split even when the entity type would otherwise say `channel`).
		expect(capturePosthogMock).toHaveBeenCalledOnce()
		expect(capturePosthogMock).toHaveBeenCalledWith(
			'slack_mention_received',
			workspaceId,
			expect.objectContaining({ channel_type: 'im', slack_team_id: 'T_INTEGRATION' }),
		)
	})

	// Public-channel @Maskin mentions arrive as a single `app_mention`
	// envelope with no paired `message`. The dedup helper must not suppress
	// these — they're the bet's primary signal.
	it('emits exactly one metric for a public-channel app_mention with no paired DM', async () => {
		const app = await createWebhookApp(createMockStorageProvider())
		const clientMsgId = `cmid_pub_${++nonce}`
		const req = await buildSignedSlackWebhook({
			type: 'event_callback',
			team_id: 'T_INTEGRATION',
			event_id: `Ev_PUB_${nonce}`,
			event: {
				type: 'app_mention',
				channel: 'C_PUBLIC',
				user: 'U_SLACK_USER',
				text: '<@UMASKIN> ship it',
				client_msg_id: clientMsgId,
				ts: `1700000001.0000${nonce}`,
			},
		})

		const res = await app.request(req)
		expect(res.status).toBe(200)
		await flushAsyncProcessing()

		expect(capturePosthogMock).toHaveBeenCalledOnce()
		expect(capturePosthogMock).toHaveBeenCalledWith(
			'slack_mention_received',
			workspaceId,
			expect.objectContaining({ channel_type: 'channel' }),
		)
	})

	// Non-mention Slack traffic — a public channel message that wasn't an
	// app_mention — must NOT tag the event row or fire the metric. Without
	// this guard the bet's downstream conversion rate would inflate to 100%
	// trivially.
	it('does not tag or emit for non-mention Slack messages', async () => {
		const app = await createWebhookApp(createMockStorageProvider())
		const req = await buildSignedSlackWebhook({
			type: 'event_callback',
			team_id: 'T_INTEGRATION',
			event_id: `Ev_T8_QUIET_${++nonce}`,
			event: {
				type: 'message',
				channel: 'C_PUBLIC',
				user: 'U_SLACK_USER',
				text: 'just a normal message',
			},
		})

		const res = await app.request(req)
		expect(res.status).toBe(200)
		await flushAsyncProcessing()

		const rows = await db
			.select()
			.from(events)
			.where(
				and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'slack.channel_message')),
			)
		expect(rows).toHaveLength(1)
		expect((rows[0]?.data as Record<string, unknown>).source).toBeUndefined()
		expect(consumeSlackAttribution(workspaceId)).toBe(false)
		expect(capturePosthogMock).not.toHaveBeenCalled()
	})
})
