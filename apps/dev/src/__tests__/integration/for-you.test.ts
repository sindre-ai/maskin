import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, files, notifications, objects, readState, sessions } from '@maskin/db/schema'
import { FOR_YOU_KIND, slimForYouItems } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertSession, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

const { default: forYouRoutes } = await import('../../routes/for-you')
const { default: eventsRoutes } = await import('../../routes/events')

function appAs(actorId: string, actorType = 'human') {
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
		c.set('actorType', actorType)
		await next()
	})
	app.route('/api/for-you', forYouRoutes)
	// The comment route an option tap goes through. It reads these two from the context; the
	// tap posts nothing that needs a live bridge or session.
	app.use('/api/events/*', async (c, next) => {
		c.set('notifyBridge' as never, {} as never)
		c.set('sessionManager' as never, { createSession: async () => undefined } as never)
		await next()
	})
	app.route('/api/events', eventsRoutes)
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

	/** A comment on the object. With `parentEventId` it is a reply in that thread. */
	async function comment(entityId: string, actor: string, parentEventId?: number) {
		const [row] = await db
			.insert(events)
			.values({
				workspaceId,
				actorId: actor,
				action: 'commented',
				entityType: 'object',
				entityId,
				data: {
					content: 'Ship it?',
					mentions: [humanId],
					...(parentEventId ? { parentEventId } : {}),
				},
			})
			.returning()
		return row.id
	}

	/** Marks the object read up to an event, the way opening its page does. */
	async function readUpTo(entityId: string, lastReadEventId: number) {
		await db.insert(readState).values({
			workspaceId,
			actorId: humanId,
			entityType: 'object',
			entityId,
			lastReadEventId,
		})
	}

	async function post(path: string, body: Record<string, unknown>, as = humanId) {
		return appAs(as).request(jsonRequest('POST', path, body, { 'X-Workspace-Id': workspaceId }))
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

	describe('a card tied to a session that has ended', () => {
		async function endedCard(sourceId: (objectId: string) => Promise<number>) {
			const task = await insertObject(db, workspaceId, humanId, {
				type: 'task',
				status: 'in_progress',
			})
			const session = await insertSession(db, workspaceId, agentId, humanId, {
				status: 'completed',
			})
			const source = await sourceId(task.id)
			const card = await item(
				{ objectId: task.id, sessionId: session.id },
				{ source_comment_id: source, headline: 'Approve the drafts' },
			)
			return { task, card, source }
		}

		it('stays when its source comment asks for an approval', async () => {
			const { card } = await endedCard((id) => decisionComment(id))
			expect((await list()).map((i) => i.notification_id)).toEqual([card.id])
		})

		it('stays when its source comment carries a draft', async () => {
			const draft = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'todo' })
			const { card } = await endedCard((id) =>
				decisionComment(id, {
					decision: { ...DECISION, draft: { object_id: draft.id, label: 'Email to Hans' } },
				}),
			)
			expect((await list()).map((i) => i.notification_id)).toEqual([card.id])
		})

		it('is dropped when its source comment is a plain comment', async () => {
			await endedCard((id) => comment(id, agentId))
			expect(await list()).toEqual([])
		})

		it('is dropped when it has no source comment', async () => {
			const session = await insertSession(db, workspaceId, agentId, humanId, { status: 'failed' })
			await item({ sessionId: session.id })
			expect(await list()).toEqual([])
		})

		it('still goes once the person replies in the thread', async () => {
			const { task, source } = await endedCard((id) => decisionComment(id))
			expect(await list()).toHaveLength(1)
			await comment(task.id, humanId, source)
			expect(await list()).toEqual([])
		})

		it('still goes once every draft it offered has been dealt with', async () => {
			const draft = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'todo' })
			await endedCard((id) =>
				decisionComment(id, {
					decision: { ...DECISION, draft: { object_id: draft.id, label: 'Email to Hans' } },
				}),
			)
			expect(await list()).toHaveLength(1)
			await db.update(objects).set({ status: 'done' }).where(eq(objects.id, draft.id))
			expect(await list()).toEqual([])
		})
	})

	describe('a curated card with a source comment', () => {
		async function card() {
			const obj = await insertObject(db, workspaceId, humanId, { type: 'bet', status: 'active' })
			const sourceId = await comment(obj.id, agentId)
			await item({ objectId: obj.id }, { source_comment_id: sourceId })
			return { obj, sourceId }
		}

		it('drops after the human replies in its thread', async () => {
			const { obj, sourceId } = await card()
			expect(await list()).toHaveLength(1)
			await comment(obj.id, humanId, sourceId)
			expect(await list()).toEqual([])
		})

		it('stays when the human only comments on the object, without replying to it', async () => {
			const { obj } = await card()
			await comment(obj.id, humanId)
			expect(await list()).toHaveLength(1)
		})

		it('stays when the human opens the object page, which moves the read position past it', async () => {
			const { obj } = await card()
			await readUpTo(obj.id, await comment(obj.id, agentId))
			expect(await list()).toHaveLength(1)
		})
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

		it('drops the card once its object leaves the status the ask assumed', async () => {
			const obj = await insertObject(db, workspaceId, humanId, { type: 'bet', status: 'define' })
			await decisionComment(obj.id, { decision: { ...DECISION, only_while_status: ['define'] } })
			expect(await list()).toHaveLength(1)
			await db.update(objects).set({ status: 'active' }).where(eq(objects.id, obj.id))
			expect(await list()).toEqual([])
		})

		it('keeps a card that names no assumed status when the object moves on', async () => {
			const obj = await insertObject(db, workspaceId, humanId, { type: 'bet', status: 'define' })
			await decisionComment(obj.id)
			await db.update(objects).set({ status: 'active' }).where(eq(objects.id, obj.id))
			expect(await list()).toHaveLength(1)
		})

		describe('what retires a decision card', () => {
			async function decisionTask() {
				const task = await insertObject(db, workspaceId, humanId, {
					type: 'task',
					status: 'backlog',
				})
				return { task, cardId: await decisionComment(task.id) }
			}

			it('keeps the card when the person opens the page, which moves the read position past it', async () => {
				const { task, cardId } = await decisionTask()
				await readUpTo(task.id, cardId)
				expect(await list()).toHaveLength(1)
			})

			it('keeps the card when the person comments on the object without replying to it', async () => {
				const { task } = await decisionTask()
				await comment(task.id, humanId)
				expect(await list()).toHaveLength(1)
			})

			it('drops the card when the person replies to it', async () => {
				const { task, cardId } = await decisionTask()
				await comment(task.id, humanId, cardId)
				expect(await list()).toEqual([])
			})

			it('drops the card when the person replies to an agent reply under it', async () => {
				const { task, cardId } = await decisionTask()
				await comment(task.id, agentId, cardId)
				expect(await list()).toHaveLength(1)
				// The server stores a reply to a reply against the root of the thread, which is the card.
				await comment(task.id, humanId, cardId)
				expect(await list()).toEqual([])
			})

			it('keeps the newest card when the person replied to an older card on the same object', async () => {
				const { task, cardId: older } = await decisionTask()
				await comment(task.id, humanId, older)
				const newer = await decisionComment(task.id)
				const items = await list()
				expect(items).toHaveLength(1)
				expect(items[0]).toMatchObject({ source: 'decision', entity_id: task.id })
				// Answering the newer card retires it.
				await comment(task.id, humanId, newer)
				expect(await list()).toEqual([])
			})

			it('drops a card that is itself a reply once the person replies after it in that thread', async () => {
				const task = await insertObject(db, workspaceId, humanId, {
					type: 'task',
					status: 'backlog',
				})
				const root = await comment(task.id, agentId)
				const [card] = await db
					.insert(events)
					.values({
						workspaceId,
						actorId: agentId,
						action: 'commented',
						entityType: 'object',
						entityId: task.id,
						data: {
							content: 'Approve?',
							mentions: [humanId],
							parentEventId: root,
							decision: DECISION,
						},
					})
					.returning()
				expect(card.id).toBeGreaterThan(root)
				expect(await list()).toHaveLength(1)
				// Replies are stored against the root, so this is how a reply to the card arrives.
				await comment(task.id, humanId, root)
				expect(await list()).toEqual([])
			})

			it('drops the card when the person dismisses it, and brings it back on undo', async () => {
				const { task, cardId } = await decisionTask()
				const [card] = await list()
				expect(card).toMatchObject({ source: 'decision', entity_id: task.id })

				const dismissed = await post('/api/for-you/dismissals', { source_comment_id: cardId })
				expect(dismissed.status).toBe(200)
				expect(await list()).toEqual([])
				// Dismissing twice is fine.
				expect((await post('/api/for-you/dismissals', { source_comment_id: cardId })).status).toBe(
					200,
				)
				// Opening the page afterwards changes nothing.
				await readUpTo(task.id, cardId)
				expect(await list()).toEqual([])

				const undone = await post('/api/for-you/dismissals/undo', { source_comment_id: cardId })
				expect(undone.status).toBe(200)
				expect(await list()).toHaveLength(1)
			})

			it("does not let one person's dismissal hide the card from another", async () => {
				const { cardId } = await decisionTask()
				const other = await insertActor(db, {
					type: 'human',
					name: 'Someone else',
					email: `other_${Date.now()}_${Math.random()}@example.com`,
				})
				const res = await post('/api/for-you/dismissals', { source_comment_id: cardId }, other.id)
				expect(res.status).toBe(200)
				expect(await list()).toHaveLength(1)
			})
		})

		describe('an option tap', () => {
			it('posts a reply threaded to the card, and that reply retires the card', async () => {
				const task = await insertObject(db, workspaceId, humanId, {
					type: 'task',
					status: 'backlog',
				})
				const cardId = await decisionComment(task.id)
				expect(await list()).toHaveLength(1)

				// What the web feed card sends when a person taps an option: the option label as the
				// content, with the card's event id as the parent. The iOS handler sends the same.
				const res = await appAs(humanId).request(
					jsonRequest(
						'POST',
						'/api/events',
						{ entity_id: task.id, content: 'Send as is', parent_event_id: cardId },
						{ 'X-Workspace-Id': workspaceId },
					),
				)
				expect(res.status).toBe(201)
				const reply = (await res.json()) as { data: { parentEventId?: number | null } }
				expect(reply.data.parentEventId).toBe(cardId)
				expect(await list()).toEqual([])
			})
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

	describe('Dismiss on a curated card', () => {
		it('drops the card, stays gone when the page is opened, and comes back on undo', async () => {
			const obj = await insertObject(db, workspaceId, humanId, { type: 'bet', status: 'active' })
			const sourceId = await comment(obj.id, agentId)
			const card = await item({ objectId: obj.id }, { source_comment_id: sourceId })
			expect(await list()).toHaveLength(1)

			const dismissed = await post('/api/for-you/dismissals', { notification_id: card.id })
			expect(dismissed.status).toBe(200)
			const [row] = await db.select().from(notifications).where(eq(notifications.id, card.id))
			expect(row.status).toBe('dismissed')
			expect(await list()).toEqual([])
			await readUpTo(obj.id, sourceId)
			expect(await list()).toEqual([])

			const undone = await post('/api/for-you/dismissals/undo', { notification_id: card.id })
			expect(undone.status).toBe(200)
			expect(await list()).toHaveLength(1)
		})

		it("refuses a card that is not the person's own, and a body that names nothing", async () => {
			const other = await insertActor(db, {
				type: 'human',
				name: 'Someone else',
				email: `other_${Date.now()}_${Math.random()}@example.com`,
			})
			const theirs = await item({ targetActorId: other.id })
			expect((await post('/api/for-you/dismissals', { notification_id: theirs.id })).status).toBe(
				404,
			)
			const [row] = await db.select().from(notifications).where(eq(notifications.id, theirs.id))
			expect(row.status).toBe('pending')
			expect((await post('/api/for-you/dismissals', {})).status).toBe(400)
		})

		it('does not accept the id of a comment from another workspace', async () => {
			const otherWs = (await insertWorkspace(db, humanId)).id
			const obj = await insertObject(db, otherWs, humanId, { type: 'bet', status: 'active' })
			const [foreign] = await db
				.insert(events)
				.values({
					workspaceId: otherWs,
					actorId: agentId,
					action: 'commented',
					entityType: 'object',
					entityId: obj.id,
					data: { content: 'x' },
				})
				.returning()
			expect(
				(await post('/api/for-you/dismissals', { source_comment_id: foreign.id })).status,
			).toBe(404)
		})
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

	describe('what the list_for_you tool reads from the same route', () => {
		async function listAs(actorId: string, type: string, forActorId?: string) {
			const qs = forActorId ? `?for_actor_id=${forActorId}` : ''
			return appAs(actorId, type).request(
				jsonGet(`/api/for-you${qs}`, { 'X-Workspace-Id': workspaceId }),
			)
		}

		it('gives the same cards in the same order as the web, with every hidden case left out', async () => {
			const open = (status = 'active') =>
				insertObject(db, workspaceId, humanId, { type: 'bet', status })

			// Hidden: answered, dismissed, ended session, closed object, only_while_status moved on.
			const answered = await open()
			const answeredSource = await comment(answered.id, agentId)
			await item(
				{ objectId: answered.id },
				{ source_comment_id: answeredSource, headline: 'answered' },
			)
			await comment(answered.id, humanId, answeredSource)

			const dismissed = await open()
			const dismissedSource = await comment(dismissed.id, agentId)
			const dismissedCard = await item(
				{ objectId: dismissed.id },
				{ source_comment_id: dismissedSource, headline: 'dismissed' },
			)
			await post('/api/for-you/dismissals', { notification_id: dismissedCard.id })

			const ended = await insertSession(db, workspaceId, agentId, humanId, { status: 'completed' })
			await item({ sessionId: ended.id }, { headline: 'ended session' })

			const closed = await open('completed')
			await item({ objectId: closed.id }, { headline: 'closed object' })

			const moved = await open('active')
			await item({ objectId: moved.id }, { headline: 'moved on', only_while_status: ['proposed'] })

			// Shown: a card due at a set time, a card with no object, and a decision card.
			const due = await open('proposed')
			const live = await item(
				{ objectId: due.id },
				{
					rank: 1,
					headline: 'Flip the bet to active',
					only_while_status: ['proposed'],
					due_at: '2026-10-26T08:00:00Z',
				},
			)
			const noObject = await item({}, { rank: 2, headline: 'Daily budget' })
			const task = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'backlog' })
			await decisionComment(task.id)

			const res = await listAs(humanId, 'human')
			expect(res.status).toBe(200)
			const { items } = (await res.json()) as {
				items: Array<{ notification_id: string | null; headline: string; due_at: string | null }>
			}
			expect(items.map((i) => i.headline)).toEqual([
				'Flip the bet to active',
				'Daily budget',
				'Send the note to Hans?',
			])
			expect(items.map((i) => i.notification_id)).toEqual([live.id, noObject.id, null])
			expect(items[0].due_at).toBe('2026-10-26T08:00:00.000Z')
			expect(items[1].due_at).toBeNull()

			const slim = slimForYouItems(items as never, 10)
			expect(slim.total).toBe(3)
			expect(slim.items.map((c) => c.headline)).toEqual(items.map((i) => i.headline))
			expect(slim.items.map((c) => c.notification_id)).toEqual(items.map((i) => i.notification_id))
			expect(slim.items[0]).toMatchObject({ title: due.title, due_at: '2026-10-26T08:00:00.000Z' })
			expect(slim.items[1]).toMatchObject({ object_id: null, title: null })
		})

		it("lets an agent read a member's list and returns the same cards as that member sees", async () => {
			await item({}, { headline: 'Approve the launch' })
			const own = await (await listAs(humanId, 'human')).json()
			const res = await listAs(agentId, 'agent', humanId)
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual(own)
		})

		it('lets a person ask for their own list by id', async () => {
			expect((await listAs(humanId, 'human', humanId)).status).toBe(200)
		})

		it("refuses a person who asks for someone else's list", async () => {
			const res = await listAs(humanId, 'human', agentId)
			expect(res.status).toBe(403)
		})

		it('answers 404 when an agent asks for an actor that is not a member', async () => {
			const stranger = await insertActor(db, {})
			const res = await listAs(agentId, 'agent', stranger.id)
			expect(res.status).toBe(404)
		})
	})
})
