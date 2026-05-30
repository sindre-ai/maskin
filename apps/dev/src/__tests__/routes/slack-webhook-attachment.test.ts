import { randomUUID } from 'node:crypto'
import { createHmac } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { buildIntegration } from '../factories'
import { createMockStorageProvider, createTestContext } from '../setup'

// Mock only the token manager — the route → fan-out → events insert wire-up is
// what this test exists to exercise, so WebhookHandler, slackEventNormalizer,
// and slackWebhookFanOut all run for real.
const getValidTokenMock = vi.fn()
vi.mock('../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		getValidToken = getValidTokenMock
	},
}))

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
	const base = `v0:${timestamp}:${body}`
	const digest = createHmac('sha256', SIGNING_SECRET).update(base).digest('hex')
	return `v0=${digest}`
}

async function buildSignedSlackWebhook(body: Record<string, unknown>) {
	const raw = JSON.stringify(body)
	const timestamp = String(Math.floor(Date.now() / 1000))
	const signature = signSlackBody(raw, timestamp)
	return new Request('http://localhost/api/webhooks/slack', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-slack-signature': signature,
			'x-slack-request-timestamp': timestamp,
		},
		body: raw,
	})
}

async function createWebhookTestApp(storage: StorageProvider) {
	const { webhookApp } = await import('../../routes/integrations')
	const app = new OpenAPIHono<Env>()
	const { db, mockResults, calls } = createTestContext()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', 'test-actor-id')
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('storageProvider', storage)
		await next()
	})
	app.route('/api/webhooks', webhookApp)
	return { app, db, mockResults, calls }
}

describe('POST /api/webhooks/slack — file attachment persistence', () => {
	let prevSecret: string | undefined

	beforeEach(() => {
		prevSecret = process.env.SLACK_SIGNING_SECRET
		process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET
		getValidTokenMock.mockReset().mockResolvedValue('xoxb-test')
	})

	afterEach(() => {
		if (prevSecret === undefined) process.env.SLACK_SIGNING_SECRET = undefined
		else process.env.SLACK_SIGNING_SECRET = prevSecret
		vi.restoreAllMocks()
	})

	// DOD: A signed Slack webhook with event.files lands an event whose
	// data.maskin_file_ids is non-empty. This is the route → fan-out → events
	// hop that the unit test in slack-fan-out.test.ts cannot exercise.
	it('persists maskin_file_ids onto the inserted event when the message carries files', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: () => Promise.resolve(new TextEncoder().encode('payload').buffer),
		} as unknown as Response)

		const persistedFileId = randomUUID()
		const storage = createMockStorageProvider()

		// Both real integration row reads (route lookup + fan-out lookup) draw
		// from the same select queue. Returning() on the files insert returns
		// the fully shaped row that fan-out passes through into the event data.
		const integration = buildIntegration({
			provider: 'slack',
			externalId: 'T1',
			config: { system_actor_id: 'actor-1' },
		})
		const filesReturning = [
			{
				id: persistedFileId,
				workspaceId: integration.workspaceId,
				name: 'screenshot.png',
				mimeType: 'image/png',
				sizeBytes: 'payload'.length,
			},
		]

		const { app, mockResults, calls } = await createWebhookTestApp(storage)
		// 1st select: route's matchingIntegrations lookup.
		// 2nd select: fan-out's integration lookup.
		mockResults.selectQueue = [[integration], [integration]]
		// Insert order: files row (returning) → audit event → main event.
		// (No event_id on the envelope ⇒ no webhook_deliveries claim runs.)
		mockResults.insertQueue = [filesReturning, [], []]

		const req = await buildSignedSlackWebhook({
			type: 'event_callback',
			team_id: 'T1',
			event: {
				type: 'message',
				channel: 'C1',
				user: 'U1',
				text: 'check this out',
				files: [
					{
						id: 'F123',
						name: 'screenshot.png',
						mimetype: 'image/png',
						url_private: 'https://files.slack.com/files-pri/T1-F123/screenshot.png',
					},
				],
			},
		})

		const res = await app.request(req)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.ok).toBe(true)
		expect(body.count).toBe(1)

		// Find the events insert the route makes after fan-out: it's the only
		// insert whose values is an array (the route batches normalized events).
		const eventInserts = calls.inserts.filter((v) => Array.isArray(v)) as Array<
			Array<{ entityType: string; data: { maskin_file_ids?: unknown } }>
		>
		expect(eventInserts).toHaveLength(1)
		const eventRows = eventInserts[0]
		expect(eventRows).toBeDefined()
		const row = eventRows?.[0]
		expect(row?.entityType).toBe('slack.channel_message')
		const fileIds = row?.data?.maskin_file_ids
		expect(Array.isArray(fileIds)).toBe(true)
		expect(fileIds as string[]).toEqual([persistedFileId])
	})

	// Counterpart: the same route must NOT fabricate maskin_file_ids when the
	// message has no attachments — otherwise we'd be claiming a non-existent
	// file is attached to the eventual insight.
	it('omits maskin_file_ids when the message has no files', async () => {
		const integration = buildIntegration({
			provider: 'slack',
			externalId: 'T1',
			config: { system_actor_id: 'actor-1' },
		})

		const { app, mockResults, calls } = await createWebhookTestApp(createMockStorageProvider())
		mockResults.selectQueue = [[integration]]
		mockResults.insertQueue = [[]]

		const req = await buildSignedSlackWebhook({
			type: 'event_callback',
			team_id: 'T1',
			event: { type: 'message', channel: 'C1', user: 'U1', text: 'no files here' },
		})

		const res = await app.request(req)
		expect(res.status).toBe(200)

		const eventInserts = calls.inserts.filter((v) => Array.isArray(v)) as Array<
			Array<{ data: Record<string, unknown> }>
		>
		expect(eventInserts).toHaveLength(1)
		expect(eventInserts[0]?.[0]?.data?.maskin_file_ids).toBeUndefined()
	})
})
