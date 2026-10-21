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

	const DECISION = {
		title: 'Send the note to Hans?',
		summary: 'Hans cancelled billing on 12 Oct and renewal is in 4 days.',
		ask: 'This goes to Hans in your name, so I will not send it alone.',
		options: [
			{
				label: 'Send as is',
				recommended: true,
				consequences: ['Reaches Hans today', 'Cannot be recalled'],
			},
			{ label: 'Skip', consequences: ['Nothing is sent', 'Renewal may lapse'] },
		],
	}

	/** A comment from an agent that asks the human for a call (or just mentions them). */
	async function decisionComment(
		entityId: string,
		extra: { decision?: Record<string, unknown> | null; mentions?: string[] } = {},
	) {
		const decision = extra.decision === undefined ? DECISION : extra.decision
		const [row] = await db
			.insert(events)
			.values({
				workspaceId,
				actorId: agentId,
				action: 'commented',
				entityType: 'object',
				entityId,
				data: {
					content: 'Approve the note to Hans.',
					mentions: extra.mentions ?? [humanId],
					...(decision ? { decision } : {}),
				},
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
		return (
			(await res.json()) as {
				items: Array<{
					notification_id: string | null
					source: string
					headline: string
					entity_id: string | null
					latest_mention?: {
						decision: { title: string; draft?: { body?: string } } | null
					}
				}>
			}
		).items
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

	it('keeps an item whose source comment id was written as a string', async () => {
		const obj = await insertObject(db, workspaceId, humanId, { type: 'bet', status: 'active' })
		const sourceId = await comment(obj.id, agentId)
		await item({ objectId: obj.id }, { source_comment_id: String(sourceId) })
		expect(await list()).toHaveLength(1)
	})

	it('drops an item whose object is no longer in the status the ask assumed', async () => {
		const obj = await insertObject(db, workspaceId, humanId, { type: 'bet', status: 'proposed' })
		await item({ objectId: obj.id }, { only_while_status: ['proposed'] })
		expect(await list()).toHaveLength(1)
		await db.update(objects).set({ status: 'active' }).where(eq(objects.id, obj.id))
		expect(await list()).toEqual([])
	})

	describe('decision cards addressed to the person', () => {
		it('lists an unread decision card with no notification behind it', async () => {
			const obj = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'backlog' })
			await decisionComment(obj.id)
			const items = await list()
			expect(items).toHaveLength(1)
			expect(items[0]).toMatchObject({
				source: 'decision',
				notification_id: null,
				entity_id: obj.id,
				headline: 'Send the note to Hans?',
			})
		})

		it('does not list a plain mention, or a decision addressed to someone else', async () => {
			const obj = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'backlog' })
			await decisionComment(obj.id, { decision: null })
			await decisionComment(obj.id, { mentions: [agentId] })
			expect(await list()).toEqual([])
		})

		it('drops the card once its object is closed, including discarded', async () => {
			const obj = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'backlog' })
			await decisionComment(obj.id)
			expect(await list()).toHaveLength(1)
			await db.update(objects).set({ status: 'discarded' }).where(eq(objects.id, obj.id))
			expect(await list()).toEqual([])
		})

		it('drops the card after the person replies or reads past it', async () => {
			const replied = await insertObject(db, workspaceId, humanId, {
				type: 'task',
				status: 'backlog',
			})
			await decisionComment(replied.id)
			await comment(replied.id, humanId)

			const read = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'backlog' })
			const readId = await decisionComment(read.id)
			await db.insert(readState).values({
				workspaceId,
				actorId: humanId,
				entityType: 'object',
				entityId: read.id,
				lastReadEventId: readId,
			})
			expect(await list()).toEqual([])
		})

		it('lists a curated item first and does not repeat its object as a decision card', async () => {
			const both = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'backlog' })
			await decisionComment(both.id)
			await item({ objectId: both.id }, { headline: 'Curated one' })
			const other = await insertObject(db, workspaceId, humanId, {
				type: 'task',
				status: 'backlog',
			})
			await decisionComment(other.id)

			const items = await list()
			expect(items.map((i) => i.source)).toEqual(['curated', 'decision'])
			expect(items[1]?.entity_id).toBe(other.id)
		})

		it("fills a draft's text from the draft object, not from when the card was posted", async () => {
			const draft = await insertObject(db, workspaceId, humanId, {
				type: 'task',
				status: 'backlog',
				content: 'Hej Hans, må jeg ringe i morgen?',
			})
			const obj = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'backlog' })
			await decisionComment(obj.id, {
				decision: { ...DECISION, draft: { object_id: draft.id, label: 'Email to Hans' } },
			})
			const items = await list()
			expect(items[0]?.latest_mention?.decision?.draft?.body).toBe(
				'Hej Hans, må jeg ringe i morgen?',
			)
		})
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
