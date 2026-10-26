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

	async function listFull() {
		const res = await appAs(humanId).request(
			jsonGet('/api/for-you', { 'X-Workspace-Id': workspaceId }),
		)
		expect(res.status).toBe(200)
		return ((await res.json()) as { items: Array<{ latest_event_id: number | null }> }).items
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

		describe('a card whose drafts have all been dealt with', () => {
			async function draftTask(status: string) {
				return insertObject(db, workspaceId, humanId, { type: 'task', status, content: 'Hej' })
			}
			const withDrafts = (ids: string[]) => ({
				...DECISION,
				drafts: ids.map((object_id, i) => ({ id: `d${i}`, object_id, label: `Reply ${i}` })),
			})

			it('drops once every draft task is done or discarded', async () => {
				const sent = await draftTask('done')
				const skipped = await draftTask('discarded')
				const obj = await insertObject(db, workspaceId, humanId, {
					type: 'task',
					status: 'backlog',
				})
				await decisionComment(obj.id, { decision: withDrafts([sent.id, skipped.id]) })
				expect(await list()).toEqual([])
			})

			it('drops a card with a single draft once its task is done', async () => {
				const sent = await draftTask('done')
				const obj = await insertObject(db, workspaceId, humanId, {
					type: 'task',
					status: 'backlog',
				})
				await decisionComment(obj.id, {
					decision: { ...DECISION, draft: { object_id: sent.id, label: 'Email to Hans' } },
				})
				expect(await list()).toEqual([])
			})

			it('keeps the card while one draft task is still open', async () => {
				const sent = await draftTask('done')
				const waiting = await draftTask('in_review')
				const obj = await insertObject(db, workspaceId, humanId, {
					type: 'task',
					status: 'backlog',
				})
				await decisionComment(obj.id, { decision: withDrafts([sent.id, waiting.id]) })
				expect(await list()).toHaveLength(1)
			})

			it('keeps a card that has a draft with no task behind it', async () => {
				const sent = await draftTask('done')
				const obj = await insertObject(db, workspaceId, humanId, {
					type: 'task',
					status: 'backlog',
				})
				await decisionComment(obj.id, {
					decision: {
						...DECISION,
						drafts: [
							{ object_id: sent.id, label: 'Sent one' },
							{ body: 'Hi', label: 'Text only' },
						],
					},
				})
				expect(await list()).toHaveLength(1)
			})

			it('drops a curated item whose source card has finished drafts', async () => {
				const sent = await draftTask('done')
				const obj = await insertObject(db, workspaceId, humanId, {
					type: 'task',
					status: 'backlog',
				})
				const sourceId = await decisionComment(obj.id, {
					decision: withDrafts([sent.id]),
					mentions: [agentId],
				})
				await item({}, { source_comment_id: sourceId })
				expect(await list()).toEqual([])
			})
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

	describe('a curated item with no source comment', () => {
		it('offers the newest activity on its object as the read position', async () => {
			const obj = await insertObject(db, workspaceId, humanId, {
				type: 'task',
				status: 'in_review',
			})
			await comment(obj.id, agentId)
			const newest = await comment(obj.id, agentId)
			await item({ objectId: obj.id }, { headline: 'Graduate 5 wiki pages' })
			const items = await listFull()
			expect(items).toHaveLength(1)
			expect(items[0]?.latest_event_id).toBe(newest)
		})

		it('drops once the person has read the object, and stays gone when it gets new activity', async () => {
			const obj = await insertObject(db, workspaceId, humanId, {
				type: 'task',
				status: 'in_review',
			})
			const before = await comment(obj.id, agentId)
			await item({ objectId: obj.id }, { headline: 'Graduate 5 wiki pages' })
			expect(await list()).toHaveLength(1)
			await db.insert(readState).values({
				workspaceId,
				actorId: humanId,
				entityType: 'object',
				entityId: obj.id,
				lastReadEventId: before,
			})
			await comment(obj.id, agentId)
			expect(await list()).toEqual([])
		})

		it('keeps the item when new activity arrives that the person has not read', async () => {
			const obj = await insertObject(db, workspaceId, humanId, {
				type: 'task',
				status: 'in_review',
			})
			await comment(obj.id, agentId)
			await item({ objectId: obj.id }, { headline: 'Graduate 5 wiki pages' })
			await comment(obj.id, agentId)
			expect(await list()).toHaveLength(1)
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
