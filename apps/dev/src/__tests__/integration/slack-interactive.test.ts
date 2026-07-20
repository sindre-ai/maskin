import { createHmac, randomUUID } from 'node:crypto'
import { events, objects, slackUserLinks } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { buildObjectBlockId } from '../../lib/integrations/providers/slack/interactive'
import { webhookApp } from '../../routes/integrations'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

const SIGNING_SECRET = 'test-slack-signing-secret'
const SLACK_TEAM_ID = 'T_TEST_TEAM'
const SLACK_USER_ID = 'U_TEST_USER'

beforeAll(() => {
	// Vitest runs each test file in its own worker, so we don't restore the
	// previous value — nothing else in this process consumes the var.
	process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET
})

function signSlackRequest(rawBody: string, timestamp: string): string {
	const base = `v0:${timestamp}:${rawBody}`
	const digest = createHmac('sha256', SIGNING_SECRET).update(base).digest('hex')
	return `v0=${digest}`
}

function makeSignedRequest(rawBody: string, headers: Record<string, string> = {}) {
	const timestamp = Math.floor(Date.now() / 1000).toString()
	const signature = signSlackRequest(rawBody, timestamp)
	return new Request('http://localhost/api/webhooks/slack-interactive', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'x-slack-request-timestamp': timestamp,
			'x-slack-signature': signature,
			...headers,
		},
		body: rawBody,
	})
}

function buildInteractivePayload(args: {
	workspaceId: string
	objectId: string
	actionId: 'status_select' | 'driver_select'
	value: string
	triggerId?: string
}): string {
	const payload = {
		type: 'block_actions',
		team: { id: SLACK_TEAM_ID },
		user: { id: SLACK_USER_ID },
		trigger_id: args.triggerId ?? `trg-${randomUUID()}`,
		response_url: 'https://hooks.slack.example.invalid/discard',
		actions: [
			{
				type: 'static_select',
				action_id: args.actionId,
				block_id: buildObjectBlockId(args.workspaceId, args.objectId),
				selected_option: { value: args.value },
			},
		],
	}
	return `payload=${encodeURIComponent(JSON.stringify(payload))}`
}

describe('POST /api/webhooks/slack-interactive (integration)', () => {
	let workspaceId: string
	let linkedActorId: string

	beforeEach(async () => {
		await sql`TRUNCATE slack_user_links, webhook_deliveries CASCADE`

		const installer = getTestActorId()
		const ws = await insertWorkspace(db, installer, {
			settings: {
				statuses: {
					task: ['todo', 'in_progress', 'done'],
				},
			},
		})
		workspaceId = ws.id

		const linkedActor = await insertActor(db, {
			type: 'human',
			name: 'Linked Slack User',
			email: `linked-${randomUUID()}@test.invalid`,
			apiKey: `ank_${randomUUID().replace(/-/g, '')}`,
		})
		linkedActorId = linkedActor.id
		await sql`
			INSERT INTO workspace_members (workspace_id, actor_id, role)
			VALUES (${workspaceId}, ${linkedActorId}, 'member')
		`

		await db.insert(slackUserLinks).values({
			slackTeamId: SLACK_TEAM_ID,
			slackUserId: SLACK_USER_ID,
			actorId: linkedActorId,
			defaultWorkspaceId: workspaceId,
		})
	})

	it('updates object status and emits an event whose actor_id is the linked actor, not the installer', async () => {
		const obj = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'task',
			status: 'todo',
		})

		const app = createIntegrationApp({ path: '/api/webhooks', module: webhookApp })
		const rawBody = buildInteractivePayload({
			workspaceId,
			objectId: obj.id,
			actionId: 'status_select',
			value: 'in_progress',
		})

		const res = await app.request(makeSignedRequest(rawBody))

		expect(res.status).toBe(200)
		const body = (await res.json()) as { ok: boolean }
		expect(body.ok).toBe(true)

		const [updated] = await db.select().from(objects).where(eq(objects.id, obj.id)).limit(1)
		expect(updated?.status).toBe('in_progress')

		const eventRows = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, obj.id), eq(events.action, 'status_changed')))
		expect(eventRows).toHaveLength(1)
		// AC-T7 — the audit event must carry the LINKED actor, not the installer.
		expect(eventRows[0]?.actorId).toBe(linkedActorId)
		expect(eventRows[0]?.actorId).not.toBe(getTestActorId())
	})

	it('updates the driver and emits an event under the linked actor', async () => {
		const driverActor = await insertActor(db, {
			type: 'human',
			name: 'New Driver',
			email: `driver-${randomUUID()}@test.invalid`,
			apiKey: `ank_${randomUUID().replace(/-/g, '')}`,
		})
		await sql`
			INSERT INTO workspace_members (workspace_id, actor_id, role)
			VALUES (${workspaceId}, ${driverActor.id}, 'member')
		`

		const obj = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'task',
			status: 'todo',
			driver: null,
		})

		const app = createIntegrationApp({ path: '/api/webhooks', module: webhookApp })
		const rawBody = buildInteractivePayload({
			workspaceId,
			objectId: obj.id,
			actionId: 'driver_select',
			value: driverActor.id,
		})

		const res = await app.request(makeSignedRequest(rawBody))
		expect(res.status).toBe(200)

		const [updated] = await db.select().from(objects).where(eq(objects.id, obj.id)).limit(1)
		expect(updated?.driver).toBe(driverActor.id)

		const eventRows = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, obj.id), eq(events.action, 'updated')))
		expect(eventRows).toHaveLength(1)
		expect(eventRows[0]?.actorId).toBe(linkedActorId)
	})

	it('refuses to write when the Slack user has no link row, and does not change the object', async () => {
		const obj = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'task',
			status: 'todo',
		})

		await db.delete(slackUserLinks).where(eq(slackUserLinks.slackUserId, SLACK_USER_ID))

		const app = createIntegrationApp({ path: '/api/webhooks', module: webhookApp })
		const rawBody = buildInteractivePayload({
			workspaceId,
			objectId: obj.id,
			actionId: 'status_select',
			value: 'in_progress',
		})

		const res = await app.request(makeSignedRequest(rawBody))
		expect(res.status).toBe(200)

		const [unchanged] = await db.select().from(objects).where(eq(objects.id, obj.id)).limit(1)
		expect(unchanged?.status).toBe('todo')

		const evRows = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, obj.id), eq(events.action, 'status_changed')))
		expect(evRows).toHaveLength(0)
	})

	it('refuses when the linked actor is not a member of the target workspace', async () => {
		const otherInstaller = await insertActor(db, {
			type: 'human',
			name: 'Other Installer',
			email: `other-${randomUUID()}@test.invalid`,
			apiKey: `ank_${randomUUID().replace(/-/g, '')}`,
		})
		const otherWs = await insertWorkspace(db, otherInstaller.id, {
			settings: { statuses: { task: ['todo', 'in_progress', 'done'] } },
		})
		const obj = await insertObject(db, otherWs.id, otherInstaller.id, {
			type: 'task',
			status: 'todo',
		})

		const app = createIntegrationApp({ path: '/api/webhooks', module: webhookApp })
		const rawBody = buildInteractivePayload({
			workspaceId: otherWs.id,
			objectId: obj.id,
			actionId: 'status_select',
			value: 'in_progress',
		})

		const res = await app.request(makeSignedRequest(rawBody))
		expect(res.status).toBe(200)

		const [unchanged] = await db.select().from(objects).where(eq(objects.id, obj.id)).limit(1)
		expect(unchanged?.status).toBe('todo')
	})

	it('dedups retried trigger_ids — second delivery is a no-op even on a fresh object', async () => {
		const obj = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'task',
			status: 'todo',
		})

		const app = createIntegrationApp({ path: '/api/webhooks', module: webhookApp })
		const triggerId = `trg-${randomUUID()}`
		const rawBody = buildInteractivePayload({
			workspaceId,
			objectId: obj.id,
			actionId: 'status_select',
			value: 'in_progress',
			triggerId,
		})

		const first = await app.request(makeSignedRequest(rawBody))
		expect(first.status).toBe(200)

		// Reset state so we can detect the no-op.
		await db.update(objects).set({ status: 'todo' }).where(eq(objects.id, obj.id))

		const second = await app.request(makeSignedRequest(rawBody))
		expect(second.status).toBe(200)
		const body = (await second.json()) as { skipped?: string }
		expect(body.skipped).toBe('duplicate')

		const [obj2] = await db.select().from(objects).where(eq(objects.id, obj.id)).limit(1)
		expect(obj2?.status).toBe('todo')
	})

	it('returns 401 on an invalid signature and writes nothing', async () => {
		const obj = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'task',
			status: 'todo',
		})
		const app = createIntegrationApp({ path: '/api/webhooks', module: webhookApp })
		const rawBody = buildInteractivePayload({
			workspaceId,
			objectId: obj.id,
			actionId: 'status_select',
			value: 'in_progress',
		})
		const res = await app.request(
			new Request('http://localhost/api/webhooks/slack-interactive', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'x-slack-request-timestamp': Math.floor(Date.now() / 1000).toString(),
					'x-slack-signature': 'v0=bad',
				},
				body: rawBody,
			}),
		)
		expect(res.status).toBe(401)

		const [unchanged] = await db.select().from(objects).where(eq(objects.id, obj.id)).limit(1)
		expect(unchanged?.status).toBe('todo')
	})
})
