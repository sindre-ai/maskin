import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
	events,
	actors,
	integrations,
	webhookDeliveries,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { logger } from '../../lib/logger'
import integrationsRoutes, { webhookApp } from '../../routes/integrations'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

function whsec(): string {
	return `whsec_${randomBytes(32).toString('base64')}`
}

function signSvix(secret: string, id: string, ts: string, body: string): string {
	const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
	return createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
}

function svixHeaders(
	secret: string,
	body: string,
	overrides: Partial<Record<'svix-id' | 'svix-timestamp' | 'svix-signature', string>> = {},
) {
	const id = `msg_${randomUUID()}`
	const ts = String(Math.floor(Date.now() / 1000))
	const sig = signSvix(secret, id, ts, body)
	return {
		'svix-id': overrides['svix-id'] ?? id,
		'svix-timestamp': overrides['svix-timestamp'] ?? ts,
		'svix-signature': overrides['svix-signature'] ?? `v1,${sig}`,
	}
}

function buildEmailReceivedBody(emailId: string, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: 'email.received',
		created_at: new Date().toISOString(),
		data: {
			email_id: emailId,
			from: 'sender@example.com',
			to: ['agent@customer-workspace.example'],
			subject: 'Hello',
			...overrides,
		},
	})
}

function webhookRequest(token: string, body: string, headers: Record<string, string>): Request {
	return new Request(`http://localhost/api/webhooks/resend/${token}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body,
	})
}

async function seedResendIntegration(args: {
	workspaceId: string
	systemActorId: string
	accessToken: string
	webhookSecret: string
	createdBy: string
}): Promise<{ token: string; integrationId: string }> {
	const token = randomBytes(24).toString('hex')
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId: args.workspaceId,
			provider: 'resend',
			status: 'active',
			externalId: token,
			credentials: encrypt(
				JSON.stringify({
					accessToken: args.accessToken,
					webhookSecret: args.webhookSecret,
				}),
			),
			config: { system_actor_id: args.systemActorId },
			createdBy: args.createdBy,
		})
		.returning({ id: integrations.id })
	if (!row) throw new Error('failed to seed resend integration')
	return { token, integrationId: row.id }
}

async function seedSystemActor(workspaceId: string): Promise<string> {
	const [actor] = await db
		.insert(actors)
		.values({
			type: 'system',
			name: `Resend (${randomUUID().slice(0, 8)})`,
			apiKey: `ank_${randomBytes(16).toString('hex')}`,
		})
		.returning({ id: actors.id })
	if (!actor) throw new Error('failed to seed system actor')
	await db.insert(workspaceMembers).values({
		workspaceId,
		actorId: actor.id,
		role: 'system',
	})
	return actor.id
}

function buildApp() {
	return createIntegrationApp(
		{ path: '/api/integrations', module: integrationsRoutes },
		{ path: '/api/webhooks', module: webhookApp },
	)
}

describe('POST /api/webhooks/resend/:token (integration)', () => {
	const originalFetch = globalThis.fetch
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	it('rejects a delivery signed with the wrong secret (401) and writes no rows', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const systemActorId = await seedSystemActor(ws.id)
		const secret = whsec()
		const { token } = await seedResendIntegration({
			workspaceId: ws.id,
			systemActorId,
			accessToken: 're_test_key',
			webhookSecret: secret,
			createdBy: actorId,
		})

		const emailId = `em_${randomUUID()}`
		const body = buildEmailReceivedBody(emailId)
		const wrongSecretHeaders = svixHeaders(whsec(), body)
		const res = await buildApp().request(webhookRequest(token, body, wrongSecretHeaders))
		expect(res.status).toBe(401)

		const claims = await db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.workspaceId, ws.id))
		expect(claims).toHaveLength(0)

		const eventRows = await db.select().from(events).where(eq(events.workspaceId, ws.id))
		expect(eventRows).toHaveLength(0)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('returns 404 for an unknown token and writes no rows', async () => {
		const bogusToken = randomBytes(24).toString('hex')
		const body = buildEmailReceivedBody(`em_${randomUUID()}`)
		// Signature does not matter — the token miss short-circuits before verify.
		const res = await buildApp().request(
			webhookRequest(bogusToken, body, svixHeaders(whsec(), body)),
		)
		expect(res.status).toBe(404)

		const anyClaims = await db.select().from(webhookDeliveries)
		expect(anyClaims).toHaveLength(0)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('commits an events row with the fetched body when the delivery is valid (Won: body enrichment)', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const systemActorId = await seedSystemActor(ws.id)
		const secret = whsec()
		const { token, integrationId } = await seedResendIntegration({
			workspaceId: ws.id,
			systemActorId,
			accessToken: 're_test_key',
			webhookSecret: secret,
			createdBy: actorId,
		})

		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ text: 'Hi Sebk', html: '<p>Hi Sebk</p>' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		)

		const emailId = `em_${randomUUID()}`
		const body = buildEmailReceivedBody(emailId)
		const res = await buildApp().request(webhookRequest(token, body, svixHeaders(secret, body)))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const callUrl = String(fetchMock.mock.calls[0]?.[0] ?? '')
		expect(callUrl).toBe(`https://api.resend.com/emails/receiving/${emailId}`)

		const eventRows = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.entityType, 'resend.email')))
		expect(eventRows).toHaveLength(1)
		expect(eventRows[0].action).toBe('received')
		expect(eventRows[0].entityId).toBe(integrationId)
		expect(eventRows[0].actorId).toBe(systemActorId)
		const data = eventRows[0].data as Record<string, unknown>
		expect(data.email_id).toBe(emailId)
		expect(data.text).toBe('Hi Sebk')
		expect(data.html).toBe('<p>Hi Sebk</p>')

		const claims = await db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.workspaceId, ws.id))
		expect(claims).toHaveLength(1)
		expect(claims[0].processedAt).not.toBeNull()
	})

	it('does not dispatch when the fetched body is empty (Won: empty-body prevention)', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const systemActorId = await seedSystemActor(ws.id)
		const secret = whsec()
		const { token } = await seedResendIntegration({
			workspaceId: ws.id,
			systemActorId,
			accessToken: 're_test_key',
			webhookSecret: secret,
			createdBy: actorId,
		})

		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ text: '', html: '' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		)
		const warnSpy = vi.spyOn(logger, 'warn')

		const emailId = `em_${randomUUID()}`
		const body = buildEmailReceivedBody(emailId)
		const res = await buildApp().request(webhookRequest(token, body, svixHeaders(secret, body)))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, skipped: 'empty_body' })

		const eventRows = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.entityType, 'resend.email')))
		expect(eventRows).toHaveLength(0)

		// Claim consumed so a retry short-circuits: processed_at IS NOT NULL.
		const claims = await db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.workspaceId, ws.id))
		expect(claims).toHaveLength(1)
		expect(claims[0].processedAt).not.toBeNull()

		expect(warnSpy).toHaveBeenCalledWith(
			'resend.body_empty',
			expect.objectContaining({ email_id: emailId, workspace_id: ws.id }),
		)
	})

	it('is idempotent on retry — the second POST short-circuits without a body-fetch (Won: retry idempotency)', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const systemActorId = await seedSystemActor(ws.id)
		const secret = whsec()
		const { token } = await seedResendIntegration({
			workspaceId: ws.id,
			systemActorId,
			accessToken: 're_test_key',
			webhookSecret: secret,
			createdBy: actorId,
		})

		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ text: 'once' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		)

		const emailId = `em_${randomUUID()}`
		const body = buildEmailReceivedBody(emailId)
		const app = buildApp()

		const firstRes = await app.request(webhookRequest(token, body, svixHeaders(secret, body)))
		expect(firstRes.status).toBe(200)
		expect(await firstRes.json()).toEqual({ ok: true })

		// New Svix envelope (fresh id/ts/signature) — retries never reuse an old
		// signed envelope in practice, and the dedup gate is `email_id`, not the
		// envelope.
		const secondStart = Date.now()
		const secondRes = await app.request(webhookRequest(token, body, svixHeaders(secret, body)))
		const secondElapsed = Date.now() - secondStart
		expect(secondRes.status).toBe(200)
		expect(await secondRes.json()).toEqual({ ok: true, skipped: true })
		expect(secondElapsed).toBeLessThan(1000)

		expect(fetchMock).toHaveBeenCalledTimes(1)

		const eventRows = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.entityType, 'resend.email')))
		expect(eventRows).toHaveLength(1)

		const claims = await db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.workspaceId, ws.id))
		expect(claims).toHaveLength(1)
	})

	it('does not ack a retry that lands mid body-fetch, so a failed first fetch is not lost', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const systemActorId = await seedSystemActor(ws.id)
		const secret = whsec()
		const { token } = await seedResendIntegration({
			workspaceId: ws.id,
			systemActorId,
			accessToken: 're_test_key',
			webhookSecret: secret,
			createdBy: actorId,
		})

		// First body-fetch stays in flight until we settle it by hand; a 404 is a
		// terminal failure, so the first request fails without burning retries.
		let failFirstFetch: () => void = () => {}
		fetchMock.mockImplementationOnce(
			() =>
				new Promise<Response>((resolve) => {
					failFirstFetch = () => resolve(new Response('{}', { status: 404 }))
				}),
		)
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ text: 'second try' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		)

		const emailId = `em_${randomUUID()}`
		const body = buildEmailReceivedBody(emailId)
		const app = buildApp()

		const firstPending = app.request(webhookRequest(token, body, svixHeaders(secret, body)))
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

		// Resend retries while the first fetch is still running. A 2xx here tells
		// Resend the email was delivered; if the first fetch then fails, nothing
		// would ever pick it up again.
		const midFetchRes = await app.request(webhookRequest(token, body, svixHeaders(secret, body)))
		expect(midFetchRes.status).toBeGreaterThanOrEqual(400)

		failFirstFetch()
		const firstRes = await firstPending
		expect(firstRes.status).toBe(500)

		// The claim was released on failure, so the next retry re-claims and
		// starts exactly one session.
		const thirdRes = await app.request(webhookRequest(token, body, svixHeaders(secret, body)))
		expect(thirdRes.status).toBe(200)
		expect(await thirdRes.json()).toEqual({ ok: true })

		const eventRows = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.entityType, 'resend.email')))
		expect(eventRows).toHaveLength(1)
	})

	it("isolates per-workspace secrets — B's secret cannot sign for A", async () => {
		const actorId = getTestActorId()
		const wsA = await insertWorkspace(db, actorId)
		const wsB = await insertWorkspace(db, actorId)
		const sysA = await seedSystemActor(wsA.id)
		const sysB = await seedSystemActor(wsB.id)
		const secretA = whsec()
		const secretB = whsec()
		const seededA = await seedResendIntegration({
			workspaceId: wsA.id,
			systemActorId: sysA,
			accessToken: 're_a',
			webhookSecret: secretA,
			createdBy: actorId,
		})
		await seedResendIntegration({
			workspaceId: wsB.id,
			systemActorId: sysB,
			accessToken: 're_b',
			webhookSecret: secretB,
			createdBy: actorId,
		})

		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ text: 'hi from A' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		)

		const emailId = `em_${randomUUID()}`
		const body = buildEmailReceivedBody(emailId)
		const app = buildApp()

		// POST to A's URL with B's secret → 401, no rows.
		const crossRes = await app.request(
			webhookRequest(seededA.token, body, svixHeaders(secretB, body)),
		)
		expect(crossRes.status).toBe(401)

		let eventsA = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, wsA.id), eq(events.entityType, 'resend.email')))
		let eventsB = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, wsB.id), eq(events.entityType, 'resend.email')))
		expect(eventsA).toHaveLength(0)
		expect(eventsB).toHaveLength(0)

		// POST to A's URL with A's secret → 200, one events row in A only.
		const goodRes = await app.request(
			webhookRequest(seededA.token, body, svixHeaders(secretA, body)),
		)
		expect(goodRes.status).toBe(200)

		eventsA = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, wsA.id), eq(events.entityType, 'resend.email')))
		eventsB = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, wsB.id), eq(events.entityType, 'resend.email')))
		expect(eventsA).toHaveLength(1)
		expect(eventsB).toHaveLength(0)
	})

	it('CTO §12.4 route-ordering: /resend/:token wins the trie over /:provider', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const systemActorId = await seedSystemActor(ws.id)
		const secret = whsec()
		const { token } = await seedResendIntegration({
			workspaceId: ws.id,
			systemActorId,
			accessToken: 're_test_key',
			webhookSecret: secret,
			createdBy: actorId,
		})

		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ text: 'trie-ok' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		)

		const emailId = `em_${randomUUID()}`
		const body = buildEmailReceivedBody(emailId)
		const res = await buildApp().request(webhookRequest(token, body, svixHeaders(secret, body)))

		// If the /:provider catch-all had won the trie, we'd get either
		//   400 { error: { code: 'BAD_REQUEST', message: 'Provider does not support webhooks' } }
		// (once `resend` is registered without a `webhook` config), or
		//   400 { error: { code: 'BAD_REQUEST', message: 'Unknown provider' } }
		// (before Task 1 registers the provider). Neither of those is our shape.
		const bodyJson = (await res.json()) as {
			ok?: boolean
			error?: { code?: string; message?: string }
		}
		expect(res.status).toBe(200)
		expect(bodyJson).toEqual({ ok: true })
		expect(bodyJson.error).toBeUndefined()
	})
})
