import { createHmac, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { events, triggers, workspaceMembers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetWebhookRateLimits } from '../../lib/integrations/extensions'
import extensionsRoutes from '../../routes/extensions'
import { webhookApp } from '../../routes/integrations'
import triggersRoutes from '../../routes/triggers'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { TriggerRunner } from '../../services/trigger-runner'
import { insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// Agent subscribes to a webhook extension, end to end against real Postgres: an
// owner adds a custom extension, an agent (a plain workspace member) creates an
// event trigger on the entity type the extension writes, and a signed delivery
// starts a session for that agent with the delivery data in its prompt. A
// filter on a field inside the payload narrows which deliveries wake it.

const SECRET = 'a'.repeat(64)

const extensionBody = () => ({
	slug: 'acme-calls',
	name: 'Acme calls',
	webhook_config: {
		signatureScheme: 'hmac-sha256',
		signatureHeader: 'x-acme-signature',
		secretSource: 'credential',
		eventMap: {
			externalIdPath: '$.call.id',
			entityType: { literal: 'acme.call' },
			action: { literal: 'ended' },
		},
	},
	signing_secret: SECRET,
})

function signedDelivery(call: { id: string; status: string }) {
	const body = JSON.stringify({ call: { ...call, duration_seconds: 42 } })
	return {
		body,
		headers: {
			'content-type': 'application/json',
			'x-acme-signature': createHmac('sha256', SECRET).update(body).digest('hex'),
		},
	}
}

function buildApp(role: string) {
	const inner = createIntegrationApp(
		{ path: '/api/extensions', module: extensionsRoutes },
		{ path: '/api/triggers', module: triggersRoutes },
		{ path: '/api/webhooks', module: webhookApp },
	)
	// authMiddleware puts the caller's role on the context; the shared harness does not.
	const app = new Hono<{ Variables: { workspaceRole?: string } }>()
	app.use('*', async (c, next) => {
		c.set('workspaceRole', role)
		await next()
	})
	app.route('/', inner)
	return app
}

describe('an agent subscribes to a webhook extension (integration)', () => {
	let workspaceId: string
	let agentId: string

	beforeEach(async () => {
		resetWebhookRateLimits()
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
		const agent = await insertActor(db, { type: 'agent', name: 'Call follow-up agent' })
		agentId = agent.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agentId, role: 'member' })
	})

	async function addExtension() {
		const res = await buildApp('owner').request(
			jsonRequest('POST', '/api/extensions', extensionBody(), { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(201)
		return (await res.json()) as { webhookToken: string }
	}

	function subscribe(role: string, config: Record<string, unknown>) {
		return buildApp(role).request(
			jsonRequest(
				'POST',
				'/api/triggers',
				{
					name: 'Follow up on finished calls',
					type: 'event',
					config,
					action_prompt: 'A call ended. Read the delivery below and follow up.',
					target_actor_id: agentId,
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
	}

	function deliver(token: string, delivery: { body: string; headers: Record<string, string> }) {
		return buildApp('owner').request(
			new Request(`http://localhost/api/webhooks/x/${token}`, {
				method: 'POST',
				headers: delivery.headers,
				body: delivery.body,
			}),
		)
	}

	it('wakes the subscribed agent with the delivery in its prompt, and skips deliveries the filter excludes', async () => {
		const { webhookToken } = await addExtension()
		const created = await subscribe('member', {
			entity_type: 'acme.call',
			action: 'ended',
			filter: { 'call.status': 'completed' },
		})
		expect(created.status).toBe(201)

		const bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const sessionManager = { createSession } as unknown as SessionManager
		configureSessionLifecycle({ db, sessionManager })
		const runner = new TriggerRunner(db, bridge, sessionManager)
		await runner.start()
		try {
			for (const call of [
				{ id: 'call_missed', status: 'missed' },
				{ id: 'call_done', status: 'completed' },
			]) {
				const res = await deliver(webhookToken, signedDelivery(call))
				expect(await res.json()).toMatchObject({ status: 'committed' })
			}
			// The events table trigger sends a PG NOTIFY in production; the bridge is
			// emulated here the way the other trigger-runner integration tests do.
			const rows = await db
				.select()
				.from(events)
				.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'acme.call')))
			expect(rows).toHaveLength(2)
			for (const evt of rows) {
				bridge.emit('event', {
					workspace_id: workspaceId,
					entity_type: 'acme.call',
					entity_id: evt.entityId,
					action: evt.action,
					actor_id: evt.actorId,
					event_id: String(evt.id),
				})
			}
			const deadline = Date.now() + 5000
			while (createSession.mock.calls.length < 1 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50))
			}
			// Give a wrongly matched second delivery time to show up before counting.
			await new Promise((resolve) => setTimeout(resolve, 500))
		} finally {
			await runner.stop()
		}

		expect(createSession).toHaveBeenCalledTimes(1)
		const [sessionWorkspaceId, params] = createSession.mock.calls[0] as [
			string,
			{ actorId: string; actionPrompt: string },
		]
		expect(sessionWorkspaceId).toBe(workspaceId)
		expect(params.actorId).toBe(agentId)
		expect(params.actionPrompt).toContain('A call ended.')
		expect(params.actionPrompt).toContain('Triggering event:')
		const eventJson = params.actionPrompt.split('Triggering event: ')[1] as string
		expect(JSON.parse(eventJson)).toMatchObject({
			entity_type: 'acme.call',
			action: 'ended',
			data: { call: { id: 'call_done', status: 'completed', duration_seconds: 42 } },
		})
	})

	it('lets a plain member create the trigger but not the extension, and never shows the secret', async () => {
		await addExtension()

		const member = buildApp('member')
		const subscribed = await subscribe('member', { entity_type: 'acme.call', action: 'ended' })
		expect(subscribed.status).toBe(201)
		const stored = await db.select().from(triggers).where(eq(triggers.workspaceId, workspaceId))
		expect(stored).toHaveLength(1)
		expect(stored[0]?.targetActorId).toBe(agentId)

		const add = await member.request(
			jsonRequest(
				'POST',
				'/api/extensions',
				{ ...extensionBody(), slug: 'another-service', name: 'Another service' },
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(add.status).toBe(403)

		const list = await member.request(
			jsonRequest('GET', '/api/extensions', undefined, { 'x-workspace-id': workspaceId }),
		)
		expect(list.status).toBe(200)
		const listed = await list.text()
		expect(listed).toContain('acme-calls')
		expect(listed).not.toContain(SECRET)
	})
})
