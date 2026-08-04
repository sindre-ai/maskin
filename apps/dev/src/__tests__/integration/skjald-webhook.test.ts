import { createHmac, randomUUID } from 'node:crypto'
import { events, integrations, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { decrypt } from '../../lib/crypto'
import integrationsRoutes, { webhookApp } from '../../routes/integrations'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

function buildApp() {
	return createIntegrationApp(
		{ path: '/api/integrations', module: integrationsRoutes },
		{ path: '/api/webhooks', module: webhookApp },
	)
}

function signSkjaldBody(secret: string, timestamp: string, body: string): string {
	return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
}

function skjaldWebhookRequest(
	token: string,
	body: string,
	headerOverrides: Record<string, string | undefined> = {},
) {
	const headers: Record<string, string> = {}
	for (const [key, value] of Object.entries(headerOverrides)) {
		if (value !== undefined) headers[key] = value
	}
	return new Request(`http://localhost/api/webhooks/skjald/${token}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body,
	})
}

function buildTranscriptionPayload(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		meeting_id: randomUUID(),
		meeting_title: 'Weekly Sync',
		segment_count: 12,
		folder_path: '/meetings/weekly-sync',
		created_at: '2026-08-01T10:00:00.000Z',
		transcript_text: 'Full transcript text.',
		diarization_status: 'completed',
		speaker_segments: [
			{
				transcript_id: randomUUID(),
				speaker_id: 'speaker-1',
				speaker_name: 'Me',
				audio_start_time: 0.5,
				audio_end_time: 4.2,
			},
		],
		...overrides,
	})
}

async function connectAndActivate(
	app: ReturnType<typeof buildApp>,
	workspaceId: string,
	secret: string,
) {
	const connectRes = await app.request(
		jsonRequest('POST', '/api/integrations/skjald/connect', undefined, {
			'x-workspace-id': workspaceId,
		}),
	)
	expect(connectRes.status).toBe(200)
	const connectBody = (await connectRes.json()) as { webhook_url: string; integration_id: string }
	const token = connectBody.webhook_url.split('/').pop() as string

	const completeRes = await app.request(
		jsonRequest(
			'POST',
			`/api/integrations/${connectBody.integration_id}/complete`,
			{ secret },
			{ 'x-workspace-id': workspaceId },
		),
	)
	expect(completeRes.status).toBe(200)

	return { token, integrationId: connectBody.integration_id }
}

describe('POST /api/integrations/skjald/connect + /complete (integration)', () => {
	it('creates an awaiting_secret row with a token URL, then activates it with the correct secret', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const app = buildApp()

		const connectRes = await app.request(
			jsonRequest('POST', '/api/integrations/skjald/connect', undefined, {
				'x-workspace-id': ws.id,
			}),
		)
		expect(connectRes.status).toBe(200)
		const connectBody = (await connectRes.json()) as { webhook_url: string; integration_id: string }
		expect(connectBody.webhook_url).toContain('/api/webhooks/skjald/')
		expect(connectBody.integration_id).toBeTruthy()

		const [pending] = await db
			.select()
			.from(integrations)
			.where(eq(integrations.id, connectBody.integration_id))
		expect(pending.status).toBe('awaiting_secret')
		expect(pending.provider).toBe('skjald')
		expect(pending.credentials).toBe('')

		const secret = 'skjald-webhook-secret-123'
		const completeRes = await app.request(
			jsonRequest(
				'POST',
				`/api/integrations/${connectBody.integration_id}/complete`,
				{ secret },
				{ 'x-workspace-id': ws.id },
			),
		)
		expect(completeRes.status).toBe(200)
		expect(await completeRes.json()).toEqual({ activated: true })

		const [active] = await db
			.select()
			.from(integrations)
			.where(eq(integrations.id, connectBody.integration_id))
		expect(active.status).toBe('active')
		expect(decrypt(active.credentials)).toBe(secret)
	})
})

describe('POST /api/webhooks/skjald/:token (integration)', () => {
	const SECRET = 'skjald-webhook-secret-456'

	it('creates a meeting object on first delivery and updates it (idempotently) on the next', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const app = buildApp()
		const { token } = await connectAndActivate(app, ws.id, SECRET)

		const meetingId = randomUUID()
		const firstBody = buildTranscriptionPayload({ meeting_id: meetingId, transcript_text: 'v1' })
		const firstTimestamp = String(Math.floor(Date.now() / 1000))
		const firstRes = await app.request(
			skjaldWebhookRequest(token, firstBody, {
				'x-skjald-event': 'transcription.completed',
				'x-skjald-timestamp': firstTimestamp,
				'x-skjald-signature': signSkjaldBody(SECRET, firstTimestamp, firstBody),
				'x-skjald-delivery-id': randomUUID(),
			}),
		)
		expect(firstRes.status).toBe(200)
		expect(await firstRes.json()).toEqual({ ok: true })

		const afterFirst = await db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, ws.id), eq(objects.type, 'meeting')))
		expect(afterFirst).toHaveLength(1)
		expect(afterFirst[0].content).toBe('v1')
		expect(afterFirst[0].status).toBe('done')
		const firstMetadata = afterFirst[0].metadata as Record<string, unknown>
		expect(firstMetadata.external_id).toBe(meetingId)
		expect(firstMetadata.diarization_status).toBe('completed')
		expect(firstMetadata.speaker_segments).toEqual([
			{
				transcript_id: expect.any(String),
				speaker_id: 'speaker-1',
				speaker_name: 'Me',
				audio_start_time: 0.5,
				audio_end_time: 4.2,
			},
		])

		const eventsAfterFirst = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.entityType, 'meeting')))
		expect(eventsAfterFirst).toHaveLength(1)
		expect(eventsAfterFirst[0].action).toBe('created')
		expect(eventsAfterFirst[0].entityId).toBe(afterFirst[0].id)

		const secondBody = buildTranscriptionPayload({
			meeting_id: meetingId,
			meeting_title: 'Weekly Sync (updated)',
			transcript_text: 'v2',
			diarization_status: 'unavailable',
			speaker_segments: null,
		})
		const secondTimestamp = String(Math.floor(Date.now() / 1000))
		const secondRes = await app.request(
			skjaldWebhookRequest(token, secondBody, {
				'x-skjald-event': 'transcription.completed',
				'x-skjald-timestamp': secondTimestamp,
				'x-skjald-signature': signSkjaldBody(SECRET, secondTimestamp, secondBody),
				'x-skjald-delivery-id': randomUUID(),
			}),
		)
		expect(secondRes.status).toBe(200)

		const afterSecond = await db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, ws.id), eq(objects.type, 'meeting')))
		expect(afterSecond).toHaveLength(1)
		expect(afterSecond[0].id).toBe(afterFirst[0].id)
		expect(afterSecond[0].content).toBe('v2')
		expect(afterSecond[0].title).toBe('Weekly Sync (updated)')
		const secondMetadata = afterSecond[0].metadata as Record<string, unknown>
		expect(secondMetadata.diarization_status).toBe('unavailable')
		expect(secondMetadata.speaker_segments).toBeNull()

		const eventsAfterSecond = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.entityType, 'meeting')))
		expect(eventsAfterSecond).toHaveLength(2)
		expect(eventsAfterSecond.map((e) => e.action).sort()).toEqual(['created', 'updated'])
	})

	it('rejects a delivery signed with the wrong secret', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const app = buildApp()
		const { token } = await connectAndActivate(app, ws.id, SECRET)

		const body = buildTranscriptionPayload()
		const timestamp = String(Math.floor(Date.now() / 1000))
		const res = await app.request(
			skjaldWebhookRequest(token, body, {
				'x-skjald-event': 'transcription.completed',
				'x-skjald-timestamp': timestamp,
				'x-skjald-signature': signSkjaldBody('wrong-secret', timestamp, body),
				'x-skjald-delivery-id': randomUUID(),
			}),
		)
		expect(res.status).toBe(401)

		const rows = await db.select().from(objects).where(eq(objects.workspaceId, ws.id))
		expect(rows).toHaveLength(0)
	})

	it('rejects a delivery with a stale timestamp', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const app = buildApp()
		const { token } = await connectAndActivate(app, ws.id, SECRET)

		const body = buildTranscriptionPayload()
		const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600)
		const res = await app.request(
			skjaldWebhookRequest(token, body, {
				'x-skjald-event': 'transcription.completed',
				'x-skjald-timestamp': staleTimestamp,
				'x-skjald-signature': signSkjaldBody(SECRET, staleTimestamp, body),
				'x-skjald-delivery-id': randomUUID(),
			}),
		)
		expect(res.status).toBe(401)

		const rows = await db.select().from(objects).where(eq(objects.workspaceId, ws.id))
		expect(rows).toHaveLength(0)
	})

	it('does not create a duplicate object or event when a delivery id is replayed', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const app = buildApp()
		const { token } = await connectAndActivate(app, ws.id, SECRET)

		const body = buildTranscriptionPayload()
		const timestamp = String(Math.floor(Date.now() / 1000))
		const deliveryId = randomUUID()
		const request = () =>
			skjaldWebhookRequest(token, body, {
				'x-skjald-event': 'transcription.completed',
				'x-skjald-timestamp': timestamp,
				'x-skjald-signature': signSkjaldBody(SECRET, timestamp, body),
				'x-skjald-delivery-id': deliveryId,
			})

		const firstRes = await app.request(request())
		expect(firstRes.status).toBe(200)
		expect(await firstRes.json()).toEqual({ ok: true })

		const secondRes = await app.request(request())
		expect(secondRes.status).toBe(200)
		expect(await secondRes.json()).toEqual({ ok: true, skipped: true })

		const rows = await db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, ws.id), eq(objects.type, 'meeting')))
		expect(rows).toHaveLength(1)

		const eventRows = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.entityType, 'meeting')))
		expect(eventRows).toHaveLength(1)
	})

	it('returns 404 for an unknown token', async () => {
		const app = buildApp()
		const body = buildTranscriptionPayload()
		const timestamp = String(Math.floor(Date.now() / 1000))
		const res = await app.request(
			skjaldWebhookRequest(randomUUID(), body, {
				'x-skjald-event': 'transcription.completed',
				'x-skjald-timestamp': timestamp,
				'x-skjald-signature': signSkjaldBody('irrelevant-secret', timestamp, body),
				'x-skjald-delivery-id': randomUUID(),
			}),
		)
		expect(res.status).toBe(404)
	})

	it('rejects a delivery whose payload fails schema validation', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const app = buildApp()
		const { token } = await connectAndActivate(app, ws.id, SECRET)

		const body = JSON.stringify({ meeting_id: randomUUID() })
		const timestamp = String(Math.floor(Date.now() / 1000))
		const res = await app.request(
			skjaldWebhookRequest(token, body, {
				'x-skjald-event': 'transcription.completed',
				'x-skjald-timestamp': timestamp,
				'x-skjald-signature': signSkjaldBody(SECRET, timestamp, body),
				'x-skjald-delivery-id': randomUUID(),
			}),
		)
		expect(res.status).toBe(400)

		const rows = await db.select().from(objects).where(eq(objects.workspaceId, ws.id))
		expect(rows).toHaveLength(0)
	})

	describe('concurrent deliveries for the same meeting_id (TOCTOU backstop)', () => {
		it('every concurrent delivery succeeds and exactly one meeting object survives', async () => {
			const actorId = getTestActorId()
			const ws = await insertWorkspace(db, actorId)
			const app = buildApp()
			const { token } = await connectAndActivate(app, ws.id, SECRET)

			const meetingId = randomUUID()
			const attempts = 8
			const requests = Array.from({ length: attempts }, (_, i) => {
				const body = buildTranscriptionPayload({
					meeting_id: meetingId,
					transcript_text: `attempt-${i}`,
				})
				const timestamp = String(Math.floor(Date.now() / 1000))
				return skjaldWebhookRequest(token, body, {
					'x-skjald-event': 'transcription.completed',
					'x-skjald-timestamp': timestamp,
					'x-skjald-signature': signSkjaldBody(SECRET, timestamp, body),
					// Distinct delivery ids so the webhook_deliveries dedup claim
					// doesn't short-circuit the race — this exercises the DB-level
					// unique index backstop in upsertSkjaldMeeting instead.
					'x-skjald-delivery-id': randomUUID(),
				})
			})

			const responses = await Promise.all(requests.map((req) => app.request(req)))
			for (const res of responses) {
				expect(res.status).toBe(200)
			}

			const surviving = await db
				.select({ id: objects.id })
				.from(objects)
				.where(and(eq(objects.workspaceId, ws.id), eq(objects.type, 'meeting')))
			expect(surviving).toHaveLength(1)
		})
	})
})
