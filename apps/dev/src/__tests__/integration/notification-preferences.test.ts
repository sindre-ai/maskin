import { EventEmitter } from 'node:events'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	conversationParticipants,
	conversations,
	messages,
	notificationPreferences,
	notifications,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { validationFailureHook } from '../../lib/errors'
import { NotificationPushFanout } from '../../services/notification-push'
import type { PushChannel, PushMessage } from '../../services/push-types'
import { insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db } from './global-setup'

const { default: routes } = await import('../../routes/notification-preferences')

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

function appAs(actorId: string) {
	const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/notification-preferences', routes)
	return app
}

const URL = '/api/notification-preferences'

describe('notification_preferences', () => {
	let actorId: string
	let workspaceId: string

	beforeEach(async () => {
		actorId = (await insertActor(db))?.id as string
		workspaceId = (await insertWorkspace(db, actorId))?.id as string
	})

	it('GET returns defaults when no row exists, without creating one', async () => {
		const res = await appAs(actorId).request(jsonRequest('GET', URL))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({ timezone: null, briefing_time: 510, updated_at: null })
		const rows = await db
			.select()
			.from(notificationPreferences)
			.where(eq(notificationPreferences.actorId, actorId))
		expect(rows).toHaveLength(0)
	})

	it('PUT upserts idempotently, merges partial updates, and audits', async () => {
		const app = appAs(actorId)
		const put = (body: unknown) =>
			app.request(jsonRequest('PUT', URL, body, { 'X-Workspace-Id': workspaceId }))

		const first = await put({
			timezone: 'Europe/Oslo',
			quiet_hours_start: 22 * 60,
			quiet_hours_end: 7 * 60,
			categories: { tips: false },
			muted_workspace_ids: [workspaceId, workspaceId],
		})
		expect(first.status).toBe(200)
		expect(await first.json()).toMatchObject({
			timezone: 'Europe/Oslo',
			quiet_hours_start: 1320,
			quiet_hours_end: 420,
			categories: { needs_you: true, conversation: true, digest: true, tips: false },
			muted_workspace_ids: [workspaceId],
		})

		// Same call again: still one row, same content.
		const again = await put({ categories: { tips: false } })
		expect(again.status).toBe(200)
		// A partial update keeps the rest, null clears quiet hours.
		const cleared = await put({
			quiet_hours_start: null,
			quiet_hours_end: null,
			briefing_time: 480,
		})
		expect(await cleared.json()).toMatchObject({
			timezone: 'Europe/Oslo',
			quiet_hours_start: null,
			quiet_hours_end: null,
			briefing_time: 480,
			categories: { tips: false, conversation: true },
		})

		const rows = await db
			.select()
			.from(notificationPreferences)
			.where(eq(notificationPreferences.actorId, actorId))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.mutedWorkspaceIds).toEqual([workspaceId])

		const get = await app.request(jsonRequest('GET', URL))
		expect(await get.json()).toMatchObject({ briefing_time: 480, updated_at: expect.any(String) })

		const audit = await db
			.select()
			.from(events)
			.where(and(eq(events.entityType, 'notification_preferences'), eq(events.entityId, actorId)))
		expect(audit.map((e) => e.action).sort()).toEqual(['created', 'updated', 'updated'])
	})

	it('PUT rejects an invalid timezone', async () => {
		const res = await appAs(actorId).request(jsonRequest('PUT', URL, { timezone: 'Nope/Zone' }))
		expect(res.status).toBe(400)
	})

	it('enforces the minute range with CHECK constraints', async () => {
		await expect(
			db.insert(notificationPreferences).values({ actorId, quietHoursStart: 1440 }),
		).rejects.toThrow()
		await expect(
			db.insert(notificationPreferences).values({ actorId, briefingTime: -1 }),
		).rejects.toThrow()
	})

	it('applies the documented column defaults', async () => {
		await db.insert(notificationPreferences).values({ actorId })
		const [row] = await db
			.select()
			.from(notificationPreferences)
			.where(eq(notificationPreferences.actorId, actorId))
		expect(row).toMatchObject({
			timezone: null,
			quietHoursStart: null,
			quietHoursEnd: null,
			categories: { needs_you: true, conversation: true, digest: true, tips: true },
			briefingEnabled: true,
			briefingTime: 510,
			mutedWorkspaceIds: [],
		})
	})

	it('cascades when the actor is deleted', async () => {
		const other = (await insertActor(db))?.id as string
		await db.insert(notificationPreferences).values({ actorId: other })
		await db.delete(actors).where(eq(actors.id, other))
		const rows = await db
			.select()
			.from(notificationPreferences)
			.where(eq(notificationPreferences.actorId, other))
		expect(rows).toHaveLength(0)
	})

	describe('delayed push read-check against real rows', () => {
		let conversationId: string
		let messageId: number
		let notificationId: string

		beforeEach(async () => {
			const source = (await insertActor(db))?.id as string
			const [conv] = await db
				.insert(conversations)
				.values({ workspaceId, createdBy: source, title: 'Chat' })
				.returning()
			conversationId = conv?.id as string
			await db.insert(conversationParticipants).values([
				{ conversationId, actorId },
				{ conversationId, actorId: source },
			])
			const [msg] = await db
				.insert(messages)
				.values({ conversationId, actorId: source, content: 'hello' })
				.returning()
			messageId = Number(msg?.id)
			const [n] = await db
				.insert(notifications)
				.values({
					workspaceId,
					type: 'message',
					title: 'New message',
					sourceActorId: source,
					targetActorId: actorId,
					status: 'pending',
					metadata: {
						push_category: 'conversation',
						push_delay_seconds: PUSH_DELAY_SECONDS,
						conversation_id: conversationId,
						message_id: messageId,
						push_collapse_key: `chat:${conversationId}`,
					},
				})
				.returning()
			notificationId = n?.id as string
		})

		function fanout() {
			const sent: PushMessage[] = []
			const channel: PushChannel = {
				isEnabled: () => true,
				sendToActor: async (_a, m) => {
					sent.push(m)
				},
			}
			return { sent, f: new NotificationPushFanout(db, new EventEmitter() as never, [channel]) }
		}
		const ev = () => ({
			workspace_id: workspaceId,
			actor_id: actorId,
			action: 'created',
			entity_type: 'notification',
			entity_id: notificationId,
			event_id: '1',
		})
		// The skip tests change the row after handleEvent returns. The delay has to outlast that write on a
		// loaded runner, or the timer fires first and the push goes out (seen in CI with 50 ms).
		const PUSH_DELAY_SECONDS = 0.5
		const PAST_DELAY_MS = PUSH_DELAY_SECONDS * 1000 + 400
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

		it('sends after the delay while the message is unread, with the collapse key', async () => {
			const { f, sent } = fanout()
			await f.handleEvent(ev())
			expect(sent).toHaveLength(0)
			await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5_000 })
			expect(sent).toHaveLength(1)
			expect(sent[0]).toMatchObject({
				collapseKey: `chat:${conversationId}`,
				interruption: 'active',
			})
			f.stop()
		})

		it('skips when the actor read the conversation up to the message', async () => {
			const { f, sent } = fanout()
			await f.handleEvent(ev())
			await db
				.update(conversationParticipants)
				.set({ lastReadMessageId: messageId })
				.where(
					and(
						eq(conversationParticipants.conversationId, conversationId),
						eq(conversationParticipants.actorId, actorId),
					),
				)
			await sleep(PAST_DELAY_MS)
			expect(sent).toHaveLength(0)
			f.stop()
		})

		it('skips when the notification is no longer pending', async () => {
			const { f, sent } = fanout()
			await f.handleEvent(ev())
			await db
				.update(notifications)
				.set({ status: 'seen' })
				.where(eq(notifications.id, notificationId))
			await sleep(PAST_DELAY_MS)
			expect(sent).toHaveLength(0)
			f.stop()
		})

		it('reads the preferences row: a disabled category never pushes', async () => {
			await db
				.insert(notificationPreferences)
				.values({ actorId, categories: { conversation: false } })
			const { f, sent } = fanout()
			await f.handleEvent(ev())
			await sleep(PAST_DELAY_MS)
			expect(sent).toHaveLength(0)
			f.stop()
		})

		it('rolls up a burst of For You cards using the real jsonb filter', async () => {
			const source = (await insertActor(db))?.id as string
			const ids: string[] = []
			for (let i = 0; i < 3; i++) {
				const [n] = await db
					.insert(notifications)
					.values({
						workspaceId,
						type: 'needs_input',
						title: `Card ${i}`,
						sourceActorId: source,
						targetActorId: actorId,
						status: 'pending',
						metadata: { kind: 'for_you', rank: i + 1, headline: `Card ${i}` },
					})
					.returning()
				ids.push(n?.id as string)
			}
			const { f, sent } = fanout()
			await f.handleEvent({ ...ev(), entity_id: ids[2] as string })
			expect(sent).toHaveLength(1)
			expect(sent[0]).toMatchObject({
				title: '3 things need you',
				collapseKey: `foryou:${workspaceId}`,
			})
		})
	})
})
