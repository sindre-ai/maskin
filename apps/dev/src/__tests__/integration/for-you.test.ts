import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, notifications, objects, readState, sessions } from '@maskin/db/schema'
import { FOR_YOU_KIND } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertSession, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

const { default: forYouRoutes } = await import('../../routes/for-you')

function appAs(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/for-you', forYouRoutes)
	return app
}

describe('GET /api/for-you', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string

	beforeEach(async () => {
		humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
		agentId = (
			await insertActor(db, {
				type: 'agent',
				name: 'CoS',
				email: null,
				apiKey: `ank_cos_${Date.now()}_${Math.random()}`,
			})
		).id
	})

	async function comment(entityId: string, actor: string) {
		const [row] = await db
			.insert(events)
			.values({
				workspaceId,
				actorId: actor,
				action: 'commented',
				entityType: 'object',
				entityId,
				data: { content: 'Ship it?', mentions: [humanId] },
			})
			.returning()
		return row.id
	}

	async function item(
		overrides: Record<string, unknown> = {},
		meta: Record<string, unknown> = {},
		extra: Record<string, unknown> = {},
	) {
		const [row] = await db
			.insert(notifications)
			.values({
				workspaceId,
				type: 'needs_input',
				title: 'Needs you',
				sourceActorId: agentId,
				targetActorId: humanId,
				status: 'pending',
				metadata: { kind: FOR_YOU_KIND, rank: 1, headline: 'Approve the launch', ...meta },
				...extra,
				...overrides,
			})
			.returning()
		return row
	}

	async function list() {
		const res = await appAs(humanId).request(
			jsonGet('/api/for-you', { 'X-Workspace-Id': workspaceId }),
		)
		expect(res.status).toBe(200)
		return ((await res.json()) as { items: Array<{ notification_id: string; headline: string }> })
			.items
	}

	it('returns pending items in rank order', async () => {
		const second = await item({}, { rank: 2, headline: 'Second' })
		const first = await item({}, { rank: 1, headline: 'First' })
		const items = await list()
		expect(items.map((i) => i.notification_id)).toEqual([first.id, second.id])
	})

	it('ignores notifications that are not For You items or are resolved', async () => {
		await item({ metadata: { question: 'mid-session ask' } })
		await item({ status: 'resolved' })
		await item({ targetActorId: agentId })
		expect(await list()).toEqual([])
	})

	it('drops an item whose object has closed', async () => {
		const obj = await insertObject(db, workspaceId, humanId, { type: 'bet', status: 'active' })
		await item({ objectId: obj.id })
		expect(await list()).toHaveLength(1)
		await db.update(objects).set({ status: 'completed' }).where(eq(objects.id, obj.id))
		expect(await list()).toEqual([])
	})

	it('drops an item once its session has finished', async () => {
		const session = await insertSession(db, workspaceId, agentId, humanId, { status: 'running' })
		await item({ sessionId: session.id })
		expect(await list()).toHaveLength(1)
		await db.update(sessions).set({ status: 'completed' }).where(eq(sessions.id, session.id))
		expect(await list()).toEqual([])
	})

	it('drops an item after the human replies on the thread', async () => {
		const obj = await insertObject(db, workspaceId, humanId, { type: 'bet', status: 'active' })
		const sourceId = await comment(obj.id, agentId)
		await item({ objectId: obj.id }, { source_comment_id: sourceId })
		expect(await list()).toHaveLength(1)
		await comment(obj.id, humanId)
		expect(await list()).toEqual([])
	})

	it('keeps an item when a newer agent comment arrives but the human has not replied', async () => {
		const obj = await insertObject(db, workspaceId, humanId, { type: 'bet', status: 'active' })
		const sourceId = await comment(obj.id, agentId)
		await item({ objectId: obj.id }, { source_comment_id: sourceId })
		await comment(obj.id, agentId)
		expect(await list()).toHaveLength(1)
	})

	it('drops an item whose object is no longer in the status the ask assumed', async () => {
		const obj = await insertObject(db, workspaceId, humanId, { type: 'bet', status: 'proposed' })
		await item({ objectId: obj.id }, { only_while_status: ['proposed'] })
		expect(await list()).toHaveLength(1)
		await db.update(objects).set({ status: 'active' }).where(eq(objects.id, obj.id))
		expect(await list()).toEqual([])
	})

	it('drops an item the human has dismissed, and does not resurface it', async () => {
		const obj = await insertObject(db, workspaceId, humanId, { type: 'bet', status: 'active' })
		const sourceId = await comment(obj.id, agentId)
		await item({ objectId: obj.id }, { source_comment_id: sourceId })
		await db.insert(readState).values({
			workspaceId,
			actorId: humanId,
			entityType: 'object',
			entityId: obj.id,
			lastReadEventId: sourceId,
		})
		expect(await list()).toEqual([])
	})

	it('does not leak items from another workspace', async () => {
		const other = (await insertWorkspace(db, humanId)).id
		await db.insert(notifications).values({
			workspaceId: other,
			type: 'needs_input',
			title: 'Elsewhere',
			sourceActorId: agentId,
			targetActorId: humanId,
			status: 'pending',
			metadata: { kind: FOR_YOU_KIND, rank: 1, headline: 'Elsewhere' },
		})
		expect(await list()).toEqual([])
	})
})
