import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, files, notifications, objects, readState, sessions } from '@maskin/db/schema'
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

	it('drops an item whose task was discarded', async () => {
		const task = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'todo' })
		await item({ objectId: task.id })
		expect(await list()).toHaveLength(1)
		await db.update(objects).set({ status: 'discarded' }).where(eq(objects.id, task.id))
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

	describe('a card that carries a draft', () => {
		const decision = (draft: Record<string, unknown>) => ({
			title: 'Send the Northwind email?',
			summary: 'Northwind has not heard from us in 14 days.',
			ask: 'This goes to a customer in your name, so I will not send it alone.',
			options: [
				{ label: 'Hold', consequences: ['Nothing is sent', 'Northwind keeps waiting'] },
				{
					label: 'Send it',
					recommended: true,
					destructive: true,
					consequences: ['Goes out now', 'Cannot be recalled'],
				},
			],
			draft,
		})

		async function cardWith(draft: Record<string, unknown>) {
			const obj = await insertObject(db, workspaceId, humanId, {
				type: 'task',
				status: 'in_review',
			})
			const [source] = await db
				.insert(events)
				.values({
					workspaceId,
					actorId: agentId,
					action: 'commented',
					entityType: 'object',
					entityId: obj.id,
					data: { content: 'Approve?', mentions: [humanId], decision: decision(draft) },
				})
				.returning()
			await item({ objectId: obj.id }, { source_comment_id: source?.id })
			const res = await appAs(humanId).request(
				jsonGet('/api/for-you', { 'X-Workspace-Id': workspaceId }),
			)
			const body = (await res.json()) as {
				items: Array<{
					latest_mention?: {
						decision: {
							draft?: {
								body?: string
								label?: string
								file_id?: string
								file?: { id: string; name: string; mime_type: string; size_bytes: number }
								preview?: {
									kind: string
									subject: string | null
									body: string
									details: Array<{ label: string; value: string }>
									delivery?: { state: string }
								}
							}
						}
					}
				}>
			}
			return body.items[0]?.latest_mention?.decision.draft
		}

		it('fills the draft text from the object it names', async () => {
			const draftObject = await insertObject(db, workspaceId, agentId, {
				type: 'task',
				content: 'Hi Mette,\n\nThursday works.',
			})
			const draft = await cardWith({ object_id: draftObject.id })
			expect(draft?.body).toBe('Hi Mette,\n\nThursday works.')
			expect(draft?.label).toBe('Draft')
			expect(draft?.preview).toBeUndefined()
		})

		it('adds the preview and where the draft stands when the object is an email', async () => {
			const draftObject = await insertObject(db, workspaceId, agentId, {
				type: 'task',
				content: 'Hi Mette,\n\nThursday works.',
				metadata: { kind: 'email', to: 'Mette Holm <mette@northwind.dk>', subject: 'Thursday' },
			})
			const draft = await cardWith({ object_id: draftObject.id })
			expect(draft?.label).toBe('Email')
			expect(draft?.body).toBe('Hi Mette,\n\nThursday works.')
			expect(draft?.preview).toMatchObject({ subject: 'Thursday', delivery: { state: 'draft' } })
		})

		it('previews a LinkedIn message with its recipient', async () => {
			const draftObject = await insertObject(db, workspaceId, agentId, {
				type: 'task',
				content: 'Hej Merethe, tak for forbindelsen.',
				metadata: { kind: 'linkedin_message', to: 'Merethe Aas' },
			})
			const draft = await cardWith({ object_id: draftObject.id })
			expect(draft?.label).toBe('LinkedIn message')
			expect(draft?.body).toBe('Hej Merethe, tak for forbindelsen.')
			expect(draft?.preview).toMatchObject({
				kind: 'linkedin_message',
				delivery: { state: 'draft' },
			})
		})

		it('previews a LinkedIn post as only the post, with where it is published', async () => {
			const draftObject = await insertObject(db, workspaceId, agentId, {
				type: 'content',
				content: 'Account: sebk_personal\n\n--- POST ---\nThe post.\n\n--- MEDIA ---\nnone',
				metadata: { content_type: 'linkedin_post', account: 'Sebastian Krumhausen' },
			})
			const draft = await cardWith({ object_id: draftObject.id })
			expect(draft?.label).toBe('LinkedIn post')
			expect(draft?.body).toBe('The post.')
			expect(draft?.preview?.details).toEqual([
				{ label: 'Posting as', value: 'Sebastian Krumhausen' },
			])
		})

		async function insertFileRow(overrides: Record<string, unknown> = {}) {
			const [row] = await db
				.insert(files)
				.values({
					workspaceId,
					name: 'launch-page.html',
					mimeType: 'text/html',
					sizeBytes: 1200,
					storageKey: `workspaces/${workspaceId}/files/test`,
					createdBy: agentId,
					...overrides,
				})
				.returning()
			return row
		}

		it('shows a file the card is about, without any text of its own', async () => {
			const file = await insertFileRow()
			const draft = await cardWith({ file_id: file.id })
			expect(draft?.file).toEqual({
				id: file.id,
				name: 'launch-page.html',
				mime_type: 'text/html',
				size_bytes: 1200,
			})
			expect(draft?.label).toBe('launch-page.html')
			expect(draft?.body).toBeUndefined()
		})

		it('uses the label the agent gave a file', async () => {
			const file = await insertFileRow({ name: 'v3.png', mimeType: 'image/png' })
			const draft = await cardWith({ file_id: file.id, label: 'New hero image' })
			expect(draft?.label).toBe('New hero image')
			expect(draft?.file?.mime_type).toBe('image/png')
		})

		it('does not show a file from another workspace', async () => {
			const otherWorkspace = (await insertWorkspace(db, humanId)).id
			const foreign = await insertFileRow({
				workspaceId: otherWorkspace,
				storageKey: `workspaces/${otherWorkspace}/files/test`,
			})
			const draft = await cardWith({ file_id: foreign.id })
			expect(draft).toBeUndefined()
		})

		it('falls back to the stored text when the file is gone', async () => {
			const draft = await cardWith({
				file_id: '00000000-0000-4000-8000-000000000000',
				body: 'The page is attached.',
			})
			expect(draft?.file).toBeUndefined()
			expect(draft?.body).toBe('The page is attached.')
		})
	})
})
