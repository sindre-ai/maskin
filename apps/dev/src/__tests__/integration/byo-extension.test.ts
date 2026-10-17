import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { events, extensions, integrations, webhookDeliveries, workspaceMembers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decrypt } from '../../lib/crypto'
import { deliveryEntityId, resetWebhookRateLimits } from '../../lib/integrations/extensions'
import { VENDOR_RECIPES } from '../../lib/integrations/vendor-recipes'
import extensionsRoutes from '../../routes/extensions'
import { webhookApp } from '../../routes/integrations'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { TriggerRunner } from '../../services/trigger-runner'
import {
	buildCalcomDelivery,
	buildFirefliesDelivery,
} from '../../../tests/integrations/fixtures/signed-deliveries'
import { insertActor, insertTrigger, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// Tech spec section 6 steps 1 to 5 against real Postgres: a workspace owner
// creates a Fireflies extension through the API, a signed delivery commits one
// delivery row and one events row, a trigger on that event starts a session,
// and a repeat delivery is a no-op. Step 6 (access-control denial) belongs to
// the guard wrapper task.

const fireflies = VENDOR_RECIPES.find((r) => r.slug === 'fireflies')
const SECRET = 'f'.repeat(64)

function buildApp(role: string | undefined = 'owner') {
	const inner = createIntegrationApp(
		{ path: '/api/extensions', module: extensionsRoutes },
		{ path: '/api/webhooks', module: webhookApp },
	)
	// authMiddleware puts the caller's role on the context; the shared harness does not.
	const app = new Hono<{ Variables: { workspaceRole?: string } }>()
	app.use('*', async (c, next) => {
		if (role) c.set('workspaceRole', role)
		await next()
	})
	app.route('/', inner)
	return app
}

function firefliesBody(overrides: Record<string, unknown> = {}) {
	return {
		slug: 'fireflies',
		name: 'Fireflies',
		webhook_config: fireflies?.webhookConfig,
		signing_secret: SECRET,
		...overrides,
	}
}

type ExtensionJson = {
	id: string
	slug: string
	status: string
	webhookToken: string | null
	webhookUrl: string | null
	hasSigningSecret: boolean
}

async function createExtension(
	app: ReturnType<typeof buildApp>,
	workspaceId: string,
	body: Record<string, unknown> = firefliesBody(),
) {
	const res = await app.request(
		jsonRequest('POST', '/api/extensions', body, { 'x-workspace-id': workspaceId }),
	)
	return { res, json: (await res.json()) as ExtensionJson }
}

function deliveryRequest(token: string, delivery: { body: string; headers: Record<string, string> }) {
	return new Request(`http://localhost/api/webhooks/x/${token}`, {
		method: 'POST',
		headers: delivery.headers,
		body: delivery.body,
	})
}

async function ledgerRows(workspaceId: string, slug: string) {
	return db
		.select()
		.from(webhookDeliveries)
		.where(
			and(
				eq(webhookDeliveries.workspaceId, workspaceId),
				eq(webhookDeliveries.provider, `extension:${slug}`),
			),
		)
}

async function eventRows(workspaceId: string, entityType: string) {
	return db
		.select()
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, entityType)))
}

describe('extensions API (integration)', () => {
	let workspaceId: string

	beforeEach(async () => {
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
	})

	it('creates a webhook extension, stores the secret encrypted, and never returns it', async () => {
		const app = buildApp()
		const { res, json } = await createExtension(app, workspaceId)
		expect(res.status).toBe(201)
		expect(json.status).toBe('active')
		expect(json.hasSigningSecret).toBe(true)
		expect(json.webhookUrl).toMatch(/\/api\/webhooks\/x\/[A-Za-z0-9_-]{43}$/)
		expect(JSON.stringify(json)).not.toContain(SECRET)

		const [secretRow] = await db
			.select()
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.provider, 'extension:fireflies'),
				),
			)
		expect(secretRow?.actorId).toBeNull()
		expect(secretRow?.credentials).not.toContain(SECRET)
		expect(decrypt(secretRow?.credentials ?? '')).toBe(SECRET)

		const get = await app.request(
			new Request(`http://localhost/api/extensions/${json.id}`, {
				headers: { 'x-workspace-id': workspaceId },
			}),
		)
		expect(get.status).toBe(200)
		expect(await get.text()).not.toContain(SECRET)

		const list = await app.request(
			new Request('http://localhost/api/extensions', { headers: { 'x-workspace-id': workspaceId } }),
		)
		const listed = (await list.json()) as ExtensionJson[]
		expect(listed.map((e) => e.slug)).toEqual(['fireflies'])
		expect(JSON.stringify(listed)).not.toContain(SECRET)
	})

	it('refuses a webhook config with no signing secret', async () => {
		const app = buildApp()
		const { res } = await createExtension(app, workspaceId, firefliesBody({ signing_secret: undefined }))
		expect(res.status).toBe(400)
		expect(await db.select().from(extensions).where(eq(extensions.workspaceId, workspaceId))).toHaveLength(0)
	})

	it('refuses to add a webhook later without a secret, and accepts one once supplied', async () => {
		const app = buildApp()
		const { json } = await createExtension(app, workspaceId, {
			slug: 'mcp-only',
			name: 'MCP only',
		})
		const headers = { 'x-workspace-id': workspaceId }
		const noSecret = await app.request(
			jsonRequest('PATCH', `/api/extensions/${json.id}`, { webhook_config: fireflies?.webhookConfig }, headers),
		)
		expect(noSecret.status).toBe(400)
		const withSecret = await app.request(
			jsonRequest(
				'PATCH',
				`/api/extensions/${json.id}`,
				{ webhook_config: fireflies?.webhookConfig, signing_secret: SECRET },
				headers,
			),
		)
		expect(withSecret.status).toBe(200)
		const body = (await withSecret.json()) as ExtensionJson
		expect(body.webhookToken).toBeTruthy()
		expect(body.hasSigningSecret).toBe(true)
	})

	it('rejects a duplicate slug in the same workspace with 409', async () => {
		const app = buildApp()
		expect((await createExtension(app, workspaceId)).res.status).toBe(201)
		expect((await createExtension(app, workspaceId)).res.status).toBe(409)
	})

	it('keeps the slug immutable on update', async () => {
		const app = buildApp()
		const { json } = await createExtension(app, workspaceId)
		const res = await app.request(
			jsonRequest('PATCH', `/api/extensions/${json.id}`, { slug: 'renamed' }, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(400)
		const [row] = await db.select().from(extensions).where(eq(extensions.id, json.id))
		expect(row?.slug).toBe('fireflies')
	})

	it('replaces the stored secret when a new one is supplied', async () => {
		const app = buildApp()
		const { json } = await createExtension(app, workspaceId)
		const next = 'e'.repeat(64)
		const res = await app.request(
			jsonRequest('PATCH', `/api/extensions/${json.id}`, { signing_secret: next }, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		const rows = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'extension:fireflies')))
		expect(rows).toHaveLength(1)
		expect(decrypt(rows[0]?.credentials ?? '')).toBe(next)
	})

	it('rejects an mcp_config with more than 20 tools', async () => {
		const app = buildApp()
		const tools = Array.from({ length: 21 }, (_, i) => ({ name: `get_${i}`, kind: 'read' }))
		const { res } = await createExtension(app, workspaceId, {
			slug: 'too-many',
			name: 'Too many',
			mcp_config: {
				envKey: 'X_TOKEN',
				server: fireflies?.mcpConfig?.server,
				credentialProvider: 'extension:too-many',
				tools,
			},
		})
		expect(res.status).toBe(400)
	})

	it('lets only an owner or admin write', async () => {
		const memberApp = buildApp('member')
		expect((await createExtension(memberApp, workspaceId)).res.status).toBe(403)
		const gen = await memberApp.request(
			jsonRequest('POST', '/api/extensions/generate-secret', undefined, { 'x-workspace-id': workspaceId }),
		)
		expect(gen.status).toBe(403)
	})

	it('generates a 32-byte hex secret without storing anything', async () => {
		const res = await buildApp().request(
			jsonRequest('POST', '/api/extensions/generate-secret', undefined, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		expect(((await res.json()) as { secret: string }).secret).toMatch(/^[0-9a-f]{64}$/)
		expect(await db.select().from(integrations).where(eq(integrations.workspaceId, workspaceId))).toHaveLength(0)
	})

	it('does not show one workspace another workspace extension', async () => {
		const app = buildApp()
		const { json } = await createExtension(app, workspaceId)
		const otherWs = (await insertWorkspace(db, getTestActorId())).id
		const res = await app.request(
			new Request(`http://localhost/api/extensions/${json.id}`, { headers: { 'x-workspace-id': otherWs } }),
		)
		expect(res.status).toBe(404)
	})

	it('enforces global uniqueness of the webhook token at the database', async () => {
		const app = buildApp()
		const { json } = await createExtension(app, workspaceId)
		const otherWs = (await insertWorkspace(db, getTestActorId())).id
		await expect(
			db.insert(extensions).values({
				workspaceId: otherWs,
				slug: 'other',
				name: 'Other',
				webhookToken: json.webhookToken,
			}),
		).rejects.toThrow()
	})

	it('computes a dry run without writing any delivery', async () => {
		const app = buildApp()
		const { json } = await createExtension(app, workspaceId)
		const headers = { 'x-workspace-id': workspaceId }
		const ok = await app.request(
			jsonRequest(
				'POST',
				`/api/extensions/${json.id}/sample`,
				{ payload: JSON.stringify({ event: 'meeting.transcribed', meeting_id: 'abc' }) },
				headers,
			),
		)
		expect(await ok.json()).toMatchObject({
			ok: true,
			event: { externalId: 'abc', entityType: 'fireflies.transcript', action: 'ready' },
		})
		const miss = await app.request(
			jsonRequest('POST', `/api/extensions/${json.id}/sample`, { payload: '{"nope":1}' }, headers),
		)
		expect(await miss.json()).toMatchObject({ ok: false, field: 'externalId' })
		expect(await ledgerRows(workspaceId, 'fireflies')).toHaveLength(0)
		expect(await eventRows(workspaceId, 'fireflies.transcript')).toHaveLength(0)
	})
})

describe('POST /api/webhooks/x/:token (integration)', () => {
	let workspaceId: string

	beforeEach(async () => {
		resetWebhookRateLimits()
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
	})

	async function setup() {
		const app = buildApp()
		const { json } = await createExtension(app, workspaceId)
		return { app, ext: json, token: json.webhookToken as string }
	}

	it('answers 404 for an unknown token', async () => {
		const { app } = await setup()
		const res = await app.request(deliveryRequest('nope', buildFirefliesDelivery({ secret: SECRET })))
		expect(res.status).toBe(404)
	})

	it('answers 404 for a disabled extension', async () => {
		const { app, ext, token } = await setup()
		await db.update(extensions).set({ status: 'disabled' }).where(eq(extensions.id, ext.id))
		const res = await app.request(deliveryRequest(token, buildFirefliesDelivery({ secret: SECRET })))
		expect(res.status).toBe(404)
	})

	it('answers 401 for a bad signature and writes nothing', async () => {
		const { app, token } = await setup()
		const res = await app.request(
			deliveryRequest(token, buildFirefliesDelivery({ secret: 'wrong'.repeat(13) })),
		)
		expect(res.status).toBe(401)
		expect(await ledgerRows(workspaceId, 'fireflies')).toHaveLength(0)
		expect(await eventRows(workspaceId, 'fireflies.transcript')).toHaveLength(0)
	})

	it('answers 422 when the external id path does not resolve', async () => {
		const { app, token } = await setup()
		const { createHmac } = await import('node:crypto')
		const body = JSON.stringify({ event: 'meeting.transcribed' })
		const res = await app.request(
			deliveryRequest(token, {
				body,
				headers: {
					'content-type': 'application/json',
					'x-hub-signature': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
				},
			}),
		)
		expect(res.status).toBe(422)
		expect(await ledgerRows(workspaceId, 'fireflies')).toHaveLength(0)
	})

	it('commits one delivery row and one events row for a good delivery, then ignores a repeat', async () => {
		const { app, ext, token } = await setup()
		const delivery = buildFirefliesDelivery({ secret: SECRET, meetingId: 'ASxwZxCstx' })

		const first = await app.request(deliveryRequest(token, delivery))
		expect(first.status).toBe(200)
		expect(await first.json()).toMatchObject({ status: 'committed' })

		const ledger = await ledgerRows(workspaceId, 'fireflies')
		expect(ledger).toHaveLength(1)
		expect(ledger[0]?.externalId).toBe('ASxwZxCstx')
		expect(ledger[0]?.processedAt).not.toBeNull()

		const evts = await eventRows(workspaceId, 'fireflies.transcript')
		expect(evts).toHaveLength(1)
		expect(evts[0]?.action).toBe('ready')
		expect(evts[0]?.entityId).toBe(deliveryEntityId(ext.id, 'ASxwZxCstx'))
		expect(evts[0]?.data).toMatchObject({ event: 'meeting.transcribed', meeting_id: 'ASxwZxCstx' })

		const repeat = await app.request(deliveryRequest(token, delivery))
		expect(repeat.status).toBe(200)
		expect(await repeat.json()).toMatchObject({ status: 'duplicate' })
		expect(await ledgerRows(workspaceId, 'fireflies')).toHaveLength(1)
		expect(await eventRows(workspaceId, 'fireflies.transcript')).toHaveLength(1)
	})

	it('starts a session through a trigger on the committed event', async () => {
		const { app, token } = await setup()
		const agent = await insertActor(db, { type: 'agent', name: 'Meeting notes agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId, actorId: agent?.id as string, role: 'member' })
		await insertTrigger(db, workspaceId, getTestActorId(), agent?.id as string, {
			config: { entity_type: 'fireflies.transcript', action: 'ready' },
		})

		const bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const sessionManager = { createSession } as unknown as SessionManager
		configureSessionLifecycle({ db, sessionManager })
		const runner = new TriggerRunner(db, bridge, sessionManager)
		await runner.start()
		try {
			const res = await app.request(
				deliveryRequest(token, buildFirefliesDelivery({ secret: SECRET, meetingId: 'trigger-me' })),
			)
			expect(res.status).toBe(200)
			const [evt] = await eventRows(workspaceId, 'fireflies.transcript')
			// The events table trigger sends a PG NOTIFY in production; the bridge is
			// emulated here the way the other trigger-runner integration tests do.
			bridge.emit('event', {
				workspace_id: workspaceId,
				entity_type: 'fireflies.transcript',
				entity_id: evt?.entityId,
				action: 'ready',
				actor_id: evt?.actorId,
				event_id: String(evt?.id),
			})
			const deadline = Date.now() + 5000
			while (createSession.mock.calls.length < 1 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50))
			}
		} finally {
			await runner.stop()
		}
		expect(createSession).toHaveBeenCalledTimes(1)
	})

	it('answers 429 once the per-minute limit is used up', async () => {
		const { app, ext, token } = await setup()
		const [row] = await db.select().from(extensions).where(eq(extensions.id, ext.id))
		await db
			.update(extensions)
			.set({ webhookConfig: { ...(row?.webhookConfig as object), rateLimit: { perMinute: 2 } } as never })
			.where(eq(extensions.id, ext.id))
		const statuses: number[] = []
		for (const id of ['r1', 'r2', 'r3']) {
			const res = await app.request(
				deliveryRequest(token, buildFirefliesDelivery({ secret: SECRET, meetingId: id })),
			)
			statuses.push(res.status)
		}
		expect(statuses).toEqual([200, 200, 429])
	})

	it('rejects a delivery older than maxAgeSeconds when a timestamp header is configured', async () => {
		const { app, ext, token } = await setup()
		const [row] = await db.select().from(extensions).where(eq(extensions.id, ext.id))
		await db
			.update(extensions)
			.set({
				webhookConfig: {
					...(row?.webhookConfig as object),
					timestampHeader: 'x-delivery-timestamp',
					maxAgeSeconds: 60,
				} as never,
			})
			.where(eq(extensions.id, ext.id))
		const delivery = buildFirefliesDelivery({ secret: SECRET, meetingId: 'old-one' })
		const stale = await app.request(
			deliveryRequest(token, {
				...delivery,
				headers: {
					...delivery.headers,
					'x-delivery-timestamp': String(Math.floor(Date.now() / 1000) - 3600),
				},
			}),
		)
		expect(stale.status).toBe(401)
		expect(await ledgerRows(workspaceId, 'fireflies')).toHaveLength(0)
		const fresh = await app.request(
			deliveryRequest(token, {
				...delivery,
				headers: {
					...delivery.headers,
					'x-delivery-timestamp': String(Math.floor(Date.now() / 1000)),
				},
			}),
		)
		expect(fresh.status).toBe(200)
	})

	it('stops accepting the old token after regeneration', async () => {
		const { app, ext, token } = await setup()
		const regen = await app.request(
			jsonRequest('POST', `/api/extensions/${ext.id}/regenerate-token`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(regen.status).toBe(200)
		const next = (await regen.json()) as ExtensionJson
		expect(next.webhookToken).not.toBe(token)

		const delivery = buildFirefliesDelivery({ secret: SECRET, meetingId: 'after-regen' })
		expect((await app.request(deliveryRequest(token, delivery))).status).toBe(404)
		expect((await app.request(deliveryRequest(next.webhookToken as string, delivery))).status).toBe(
			200,
		)
	})

	it('verifies a Cal.com style delivery configured through the API (second vendor, config only)', async () => {
		const app = buildApp()
		const { json } = await createExtension(app, workspaceId, {
			slug: 'cal-com',
			name: 'Cal.com',
			webhook_config: {
				signatureScheme: 'hmac-sha256',
				signatureHeader: 'x-cal-signature-256',
				eventMap: {
					externalIdPath: '$.payload.uid',
					entityType: { literal: 'calcom.booking' },
					action: { path: '$.triggerEvent' },
				},
			},
			signing_secret: SECRET,
		})
		const res = await app.request(
			deliveryRequest(json.webhookToken as string, buildCalcomDelivery({ secret: SECRET, uid: 'bk_9' })),
		)
		expect(res.status).toBe(200)
		const [evt] = await eventRows(workspaceId, 'calcom.booking')
		expect(evt?.action).toBe('BOOKING_CREATED')
	})
})
