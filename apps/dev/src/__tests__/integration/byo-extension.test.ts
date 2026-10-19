import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
	events,
	extensions,
	integrations,
	webhookDeliveries,
	workspaceMembers,
} from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	buildCalcomDelivery,
	buildFirefliesDelivery,
} from '../../../tests/integrations/fixtures/signed-deliveries'
import { decrypt } from '../../lib/crypto'
import { deliveryEntityId, resetWebhookRateLimits } from '../../lib/integrations/extensions'
import { VENDOR_RECIPES } from '../../lib/integrations/vendor-recipes'
import extensionsRoutes from '../../routes/extensions'
import { webhookApp } from '../../routes/integrations'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { TriggerRunner } from '../../services/trigger-runner'
import { insertActor, insertTrigger, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/integration-events', () => ({
	trackIntegrationConnected: vi.fn().mockResolvedValue(undefined),
}))

const { trackIntegrationConnected } = await import('../../lib/analytics/integration-events')

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

function deliveryRequest(
	token: string,
	delivery: { body: string; headers: Record<string, string> },
) {
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
			new Request('http://localhost/api/extensions', {
				headers: { 'x-workspace-id': workspaceId },
			}),
		)
		const listed = (await list.json()) as ExtensionJson[]
		expect(listed.map((e) => e.slug)).toEqual(['fireflies'])
		expect(JSON.stringify(listed)).not.toContain(SECRET)
	})

	it('refuses a webhook config with no signing secret', async () => {
		const app = buildApp()
		const { res } = await createExtension(
			app,
			workspaceId,
			firefliesBody({ signing_secret: undefined }),
		)
		expect(res.status).toBe(400)
		expect(
			await db.select().from(extensions).where(eq(extensions.workspaceId, workspaceId)),
		).toHaveLength(0)
	})

	it('refuses to add a webhook later without a secret, and accepts one once supplied', async () => {
		const app = buildApp()
		const { json } = await createExtension(app, workspaceId, {
			slug: 'mcp-only',
			name: 'MCP only',
		})
		const headers = { 'x-workspace-id': workspaceId }
		const noSecret = await app.request(
			jsonRequest(
				'PATCH',
				`/api/extensions/${json.id}`,
				{ webhook_config: fireflies?.webhookConfig },
				headers,
			),
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
			jsonRequest(
				'PATCH',
				`/api/extensions/${json.id}`,
				{ slug: 'renamed' },
				{ 'x-workspace-id': workspaceId },
			),
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
			jsonRequest(
				'PATCH',
				`/api/extensions/${json.id}`,
				{ signing_secret: next },
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(200)
		const rows = await db
			.select()
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.provider, 'extension:fireflies'),
				),
			)
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
			jsonRequest('POST', '/api/extensions/generate-secret', undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(gen.status).toBe(403)
	})

	it('generates a 32-byte hex secret without storing anything', async () => {
		const res = await buildApp().request(
			jsonRequest('POST', '/api/extensions/generate-secret', undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		expect(((await res.json()) as { secret: string }).secret).toMatch(/^[0-9a-f]{64}$/)
		expect(
			await db.select().from(integrations).where(eq(integrations.workspaceId, workspaceId)),
		).toHaveLength(0)
	})

	it('does not show one workspace another workspace extension', async () => {
		const app = buildApp()
		const { json } = await createExtension(app, workspaceId)
		const otherWs = (await insertWorkspace(db, getTestActorId())).id
		const res = await app.request(
			new Request(`http://localhost/api/extensions/${json.id}`, {
				headers: { 'x-workspace-id': otherWs },
			}),
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
		const res = await app.request(
			deliveryRequest('nope', buildFirefliesDelivery({ secret: SECRET })),
		)
		expect(res.status).toBe(404)
	})

	it('answers 404 for a disabled extension', async () => {
		const { app, ext, token } = await setup()
		await db.update(extensions).set({ status: 'disabled' }).where(eq(extensions.id, ext.id))
		const res = await app.request(
			deliveryRequest(token, buildFirefliesDelivery({ secret: SECRET })),
		)
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
		expect(ledger[0]?.externalId).toBe('ASxwZxCstx:ready')
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
			.set({
				webhookConfig: { ...(row?.webhookConfig as object), rateLimit: { perMinute: 2 } } as never,
			})
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
})

// Second-vendor smoke (bet ca2a, Falsified if / Lost). The Fireflies path above
// repeated for Cal.com. The only differences are the fixture payload and the
// extension config row: the verifier, route and shim are the ones Fireflies uses.
describe('Cal.com second-vendor smoke (integration)', () => {
	let workspaceId: string
	const CAL_SECRET = 'c'.repeat(64)

	beforeEach(async () => {
		resetWebhookRateLimits()
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
	})

	// Data only: this is what the Wire Cal.com bookings to Maskin docs page tells
	// the owner to enter in the extension form.
	const calcomBody = () => ({
		slug: 'cal-com',
		name: 'Cal.com',
		webhook_config: {
			signatureScheme: 'hmac-sha256',
			signatureHeader: 'x-cal-signature-256',
			secretSource: 'credential',
			eventMap: {
				externalIdPath: '$.payload.uid',
				entityType: { literal: 'calcom.booking' },
				action: { path: '$.triggerEvent' },
			},
		},
		signing_secret: CAL_SECRET,
	})

	async function setup() {
		const app = buildApp()
		const { res, json } = await createExtension(app, workspaceId, calcomBody())
		expect(res.status).toBe(201)
		return { app, ext: json, token: json.webhookToken as string }
	}

	it('stores the secret encrypted under extension:cal-com and never returns it', async () => {
		const { ext } = await setup()
		expect(ext.hasSigningSecret).toBe(true)
		expect(JSON.stringify(ext)).not.toContain(CAL_SECRET)
		const [row] = await db
			.select()
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.provider, 'extension:cal-com'),
				),
			)
		expect(row?.actorId).toBeNull()
		expect(decrypt(row?.credentials ?? '')).toBe(CAL_SECRET)
	})

	it('answers 401 for a bad signature and writes nothing', async () => {
		const { app, token } = await setup()
		const res = await app.request(
			deliveryRequest(token, buildCalcomDelivery({ secret: 'wrong'.repeat(13) })),
		)
		expect(res.status).toBe(401)
		expect(await ledgerRows(workspaceId, 'cal-com')).toHaveLength(0)
		expect(await eventRows(workspaceId, 'calcom.booking')).toHaveLength(0)
	})

	it('answers 401 for a Fireflies style prefixed signature (Cal.com sends raw hex)', async () => {
		const { app, token } = await setup()
		const delivery = buildCalcomDelivery({ secret: CAL_SECRET })
		const res = await app.request(
			deliveryRequest(token, {
				...delivery,
				headers: {
					...delivery.headers,
					'x-cal-signature-256': `sha256=${delivery.headers['x-cal-signature-256']}`,
				},
			}),
		)
		expect(res.status).toBe(401)
		expect(await ledgerRows(workspaceId, 'cal-com')).toHaveLength(0)
	})

	it('commits one delivery row and one events row for a booking, then ignores a repeat', async () => {
		const { app, ext, token } = await setup()
		const delivery = buildCalcomDelivery({ secret: CAL_SECRET, uid: 'bk_7Hn2xQ' })

		const first = await app.request(deliveryRequest(token, delivery))
		expect(first.status).toBe(200)
		expect(await first.json()).toMatchObject({ status: 'committed' })

		const ledger = await ledgerRows(workspaceId, 'cal-com')
		expect(ledger).toHaveLength(1)
		expect(ledger[0]?.externalId).toBe('bk_7Hn2xQ:BOOKING_CREATED')
		expect(ledger[0]?.processedAt).not.toBeNull()

		const evts = await eventRows(workspaceId, 'calcom.booking')
		expect(evts).toHaveLength(1)
		expect(evts[0]?.action).toBe('BOOKING_CREATED')
		expect(evts[0]?.entityId).toBe(deliveryEntityId(ext.id, 'bk_7Hn2xQ'))
		expect(evts[0]?.data).toMatchObject({
			triggerEvent: 'BOOKING_CREATED',
			payload: { uid: 'bk_7Hn2xQ' },
		})

		const repeat = await app.request(deliveryRequest(token, delivery))
		expect(repeat.status).toBe(200)
		expect(await repeat.json()).toMatchObject({ status: 'duplicate' })
		expect(await ledgerRows(workspaceId, 'cal-com')).toHaveLength(1)
		expect(await eventRows(workspaceId, 'calcom.booking')).toHaveLength(1)
	})

	it('reads the action from the payload, so a cancelled booking carries BOOKING_CANCELLED', async () => {
		const { app, token } = await setup()
		const res = await app.request(
			deliveryRequest(
				token,
				buildCalcomDelivery({
					secret: CAL_SECRET,
					triggerEvent: 'BOOKING_CANCELLED',
					uid: 'bk_cancel',
				}),
			),
		)
		expect(res.status).toBe(200)
		const [evt] = await eventRows(workspaceId, 'calcom.booking')
		expect(evt?.action).toBe('BOOKING_CANCELLED')
	})

	it('commits a cancel after a create for the same booking, and ignores a repeated cancel', async () => {
		const { app, ext, token } = await setup()
		const created = buildCalcomDelivery({ secret: CAL_SECRET, uid: 'bk_7Hn2xQ' })
		const cancelled = buildCalcomDelivery({
			secret: CAL_SECRET,
			triggerEvent: 'BOOKING_CANCELLED',
			uid: 'bk_7Hn2xQ',
		})

		const first = await app.request(deliveryRequest(token, created))
		expect(await first.json()).toMatchObject({ status: 'committed' })
		const cancel = await app.request(deliveryRequest(token, cancelled))
		expect(cancel.status).toBe(200)
		expect(await cancel.json()).toMatchObject({ status: 'committed' })

		const ledger = await ledgerRows(workspaceId, 'cal-com')
		expect(ledger.map((r) => r.externalId).sort()).toEqual([
			'bk_7Hn2xQ:BOOKING_CANCELLED',
			'bk_7Hn2xQ:BOOKING_CREATED',
		])
		const evts = await eventRows(workspaceId, 'calcom.booking')
		expect(evts.map((e) => e.action).sort()).toEqual(['BOOKING_CANCELLED', 'BOOKING_CREATED'])
		// Both events stay on one entity, built from the bare booking id.
		for (const evt of evts) {
			expect(evt.entityId).toBe(deliveryEntityId(ext.id, 'bk_7Hn2xQ'))
		}

		const repeat = await app.request(deliveryRequest(token, cancelled))
		expect(repeat.status).toBe(200)
		expect(await repeat.json()).toMatchObject({ status: 'duplicate' })
		expect(await ledgerRows(workspaceId, 'cal-com')).toHaveLength(2)
		expect(await eventRows(workspaceId, 'calcom.booking')).toHaveLength(2)
	})

	it('starts a session for the create and another for the cancel of the same booking', async () => {
		const { app, token } = await setup()
		const agent = await insertActor(db, { type: 'agent', name: 'Booking agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId, actorId: agent?.id as string, role: 'member' })
		for (const action of ['BOOKING_CREATED', 'BOOKING_CANCELLED']) {
			await insertTrigger(db, workspaceId, getTestActorId(), agent?.id as string, {
				config: { entity_type: 'calcom.booking', action },
			})
		}

		const bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const sessionManager = { createSession } as unknown as SessionManager
		configureSessionLifecycle({ db, sessionManager })
		const runner = new TriggerRunner(db, bridge, sessionManager)
		await runner.start()
		try {
			for (const triggerEvent of ['BOOKING_CREATED', 'BOOKING_CANCELLED'] as const) {
				const res = await app.request(
					deliveryRequest(
						token,
						buildCalcomDelivery({ secret: CAL_SECRET, triggerEvent, uid: 'bk_both' }),
					),
				)
				expect(await res.json()).toMatchObject({ status: 'committed' })
			}
			// Same PG NOTIFY emulation as the trigger test above.
			for (const evt of await eventRows(workspaceId, 'calcom.booking')) {
				bridge.emit('event', {
					workspace_id: workspaceId,
					entity_type: 'calcom.booking',
					entity_id: evt.entityId,
					action: evt.action,
					actor_id: evt.actorId,
					event_id: String(evt.id),
				})
			}
			const deadline = Date.now() + 5000
			while (createSession.mock.calls.length < 2 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50))
			}
		} finally {
			await runner.stop()
		}
		expect(createSession).toHaveBeenCalledTimes(2)
	})

	it('answers 422 when the booking uid is missing', async () => {
		const { app, token } = await setup()
		const { createHmac } = await import('node:crypto')
		const body = JSON.stringify({ triggerEvent: 'BOOKING_CREATED', payload: {} })
		const res = await app.request(
			deliveryRequest(token, {
				body,
				headers: {
					'content-type': 'application/json',
					'x-cal-signature-256': createHmac('sha256', CAL_SECRET).update(body).digest('hex'),
				},
			}),
		)
		expect(res.status).toBe(422)
		expect(await ledgerRows(workspaceId, 'cal-com')).toHaveLength(0)
	})

	it('starts a session through a trigger on a committed booking', async () => {
		const { app, token } = await setup()
		const agent = await insertActor(db, { type: 'agent', name: 'Booking agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId, actorId: agent?.id as string, role: 'member' })
		await insertTrigger(db, workspaceId, getTestActorId(), agent?.id as string, {
			config: { entity_type: 'calcom.booking', action: 'BOOKING_CREATED' },
		})

		const bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const sessionManager = { createSession } as unknown as SessionManager
		configureSessionLifecycle({ db, sessionManager })
		const runner = new TriggerRunner(db, bridge, sessionManager)
		await runner.start()
		try {
			const res = await app.request(
				deliveryRequest(token, buildCalcomDelivery({ secret: CAL_SECRET, uid: 'trigger-me' })),
			)
			expect(res.status).toBe(200)
			const [evt] = await eventRows(workspaceId, 'calcom.booking')
			// Same PG NOTIFY emulation as the Fireflies trigger test above.
			bridge.emit('event', {
				workspace_id: workspaceId,
				entity_type: 'calcom.booking',
				entity_id: evt?.entityId,
				action: 'BOOKING_CREATED',
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
})

describe('integration_connected for extensions (integration)', () => {
	let workspaceId: string
	const headers = () => ({ 'x-workspace-id': workspaceId })
	const mcpConfig = () => ({
		envKey: 'X_TOKEN',
		server: fireflies?.mcpConfig?.server,
		credentialProvider: 'extension:mcp-ext',
		tools: [{ name: 'get_thing', kind: 'read' }],
	})

	beforeEach(async () => {
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
		vi.mocked(trackIntegrationConnected).mockClear()
	})

	it('fires once on the first save of an extension with a webhook, and not on a later edit', async () => {
		const app = buildApp()
		const { res, json } = await createExtension(app, workspaceId)
		expect(res.status).toBe(201)
		expect(trackIntegrationConnected).toHaveBeenCalledTimes(1)
		expect(trackIntegrationConnected).toHaveBeenCalledWith({
			provider: 'extension:fireflies',
			workspaceId,
			actorId: getTestActorId(),
			integrationId: json.id,
		})

		const edit = await app.request(
			jsonRequest('PATCH', `/api/extensions/${json.id}`, { name: 'Fireflies renamed' }, headers()),
		)
		expect(edit.status).toBe(200)
		const reSecret = await app.request(
			jsonRequest('PATCH', `/api/extensions/${json.id}`, { signing_secret: SECRET }, headers()),
		)
		expect(reSecret.status).toBe(200)
		expect(trackIntegrationConnected).toHaveBeenCalledTimes(1)
	})

	it('fires on the first save of an MCP-only extension', async () => {
		const app = buildApp()
		const { res, json } = await createExtension(app, workspaceId, {
			slug: 'mcp-ext',
			name: 'MCP ext',
			mcp_config: mcpConfig(),
		})
		expect(res.status).toBe(201)
		expect(trackIntegrationConnected).toHaveBeenCalledTimes(1)
		expect(trackIntegrationConnected).toHaveBeenCalledWith(
			expect.objectContaining({ provider: 'extension:mcp-ext', integrationId: json.id }),
		)
	})

	it('waits for the save that first adds a config when the extension was created empty', async () => {
		const app = buildApp()
		const { json } = await createExtension(app, workspaceId, { slug: 'mcp-ext', name: 'Empty' })
		expect(trackIntegrationConnected).not.toHaveBeenCalled()

		const rename = await app.request(
			jsonRequest('PATCH', `/api/extensions/${json.id}`, { name: 'Still empty' }, headers()),
		)
		expect(rename.status).toBe(200)
		expect(trackIntegrationConnected).not.toHaveBeenCalled()

		const addMcp = await app.request(
			jsonRequest('PATCH', `/api/extensions/${json.id}`, { mcp_config: mcpConfig() }, headers()),
		)
		expect(addMcp.status).toBe(200)
		expect(trackIntegrationConnected).toHaveBeenCalledTimes(1)
		expect(trackIntegrationConnected).toHaveBeenCalledWith(
			expect.objectContaining({ provider: 'extension:mcp-ext', integrationId: json.id }),
		)

		const edit = await app.request(
			jsonRequest('PATCH', `/api/extensions/${json.id}`, { name: 'Renamed' }, headers()),
		)
		expect(edit.status).toBe(200)
		expect(trackIntegrationConnected).toHaveBeenCalledTimes(1)
	})

	it('does not fire when the save is refused', async () => {
		const app = buildApp()
		const { res } = await createExtension(
			app,
			workspaceId,
			firefliesBody({ signing_secret: undefined }),
		)
		expect(res.status).toBe(400)
		await createExtension(app, workspaceId)
		const dup = await createExtension(app, workspaceId)
		expect(dup.res.status).toBe(409)
		expect(trackIntegrationConnected).toHaveBeenCalledTimes(1)
	})
})
