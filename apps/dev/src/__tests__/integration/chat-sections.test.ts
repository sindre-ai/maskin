import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	chatSectionItems,
	chatSections,
	conversationParticipants,
	conversations,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import {
	ensureWorkspaceMember,
	insertActor,
	insertConversation,
	insertWorkspace,
} from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: chatSectionsRoutes } = await import('../../routes/chat-sections')
const { default: conversationsRoutes } = await import('../../routes/conversations')

/**
 * A person's own chat list sections: /api/chat-sections. Nobody can read or change another
 * person's sections, a chat sits in at most one section per person, and a section's chats drop
 * out when the person can no longer see them. Runs against real Postgres, because the rules that
 * matter here (per-person unique names, the composite foreign key, the cascades) live in the
 * database.
 */

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

type Section = {
	id: string
	name: string
	position: number
	collapsed: boolean
	conversationIds: string[]
}

function createApp(actorId: string) {
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
	app.route('/api/chat-sections', chatSectionsRoutes)
	app.route('/api/conversations', conversationsRoutes)
	return app
}

describe('chat sections', () => {
	let workspaceId: string
	let me: string
	let other: string
	let headers: Record<string, string>

	beforeEach(async () => {
		me = getTestActorId()
		other = (await insertActor(db, { type: 'human' })).id
		workspaceId = (await insertWorkspace(db, me)).id
		await ensureWorkspaceMember(db, workspaceId, other)
		headers = { 'x-workspace-id': workspaceId }
	})

	const as = (actorId: string) => createApp(actorId)

	async function createSection(actorId: string, name: string) {
		const res = await as(actorId).request(
			jsonRequest('POST', '/api/chat-sections', { name }, headers),
		)
		return { status: res.status, body: (await res.json()) as Section }
	}

	async function listSections(actorId: string) {
		const res = await as(actorId).request(jsonGet('/api/chat-sections', headers))
		expect(res.status).toBe(200)
		return ((await res.json()) as { sections: Section[] }).sections
	}

	/** A chat both people are in. */
	async function seedChat(title: string, people: string[] = [me, other]) {
		const chat = await insertConversation(db, workspaceId, me, { title })
		await db
			.insert(conversationParticipants)
			.values(people.map((actorId) => ({ conversationId: chat.id, actorId })))
		return chat.id
	}

	const putChat = (actorId: string, sectionId: string, chatId: string) =>
		as(actorId).request(
			jsonRequest('PUT', `/api/chat-sections/${sectionId}/chats/${chatId}`, undefined, headers),
		)

	describe('own sections only', () => {
		it('lists, renames, folds, reorders and deletes only the caller’s sections', async () => {
			const work = (await createSection(me, 'Work')).body
			const home = (await createSection(me, 'Home')).body
			expect([work.position, home.position]).toEqual([0, 1])

			const patched = await as(me).request(
				jsonRequest(
					'PATCH',
					`/api/chat-sections/${work.id}`,
					{ name: ' Work stuff ', collapsed: true },
					headers,
				),
			)
			expect(patched.status).toBe(200)
			expect(await patched.json()).toMatchObject({ name: 'Work stuff', collapsed: true })

			const reordered = await as(me).request(
				jsonRequest('PUT', '/api/chat-sections/order', { ids: [home.id, work.id] }, headers),
			)
			expect(reordered.status).toBe(200)
			expect((await listSections(me)).map((s) => [s.name, s.position])).toEqual([
				['Home', 0],
				['Work stuff', 1],
			])

			const removed = await as(me).request(
				jsonRequest('DELETE', `/api/chat-sections/${home.id}`, undefined, headers),
			)
			expect(removed.status).toBe(200)
			expect((await listSections(me)).map((s) => s.name)).toEqual(['Work stuff'])
		})

		it('shows another person nothing, and answers 404 to every route on a section that is not theirs', async () => {
			const mine = (await createSection(me, 'Mine')).body
			const chatId = await seedChat('shared chat')
			await putChat(me, mine.id, chatId)

			expect(await listSections(other)).toEqual([])

			const app = as(other)
			const attempts = [
				jsonRequest('PATCH', `/api/chat-sections/${mine.id}`, { name: 'Hijacked' }, headers),
				jsonRequest('DELETE', `/api/chat-sections/${mine.id}`, undefined, headers),
				jsonRequest('PUT', `/api/chat-sections/${mine.id}/chats/${chatId}`, undefined, headers),
				jsonRequest('DELETE', `/api/chat-sections/${mine.id}/chats/${chatId}`, undefined, headers),
			]
			for (const attempt of attempts) {
				expect((await app.request(attempt)).status).toBe(404)
			}

			// Reordering names sections that are not theirs: refused, and mine are untouched.
			const reorder = await app.request(
				jsonRequest('PUT', '/api/chat-sections/order', { ids: [mine.id] }, headers),
			)
			expect(reorder.status).toBe(400)

			expect(await listSections(me)).toEqual([{ ...mine, conversationIds: [chatId] }])
		})

		it('refuses an order that is not exactly the caller’s sections', async () => {
			const a = (await createSection(me, 'A')).body
			const b = (await createSection(me, 'B')).body
			const send = async (ids: string[]) =>
				(await as(me).request(jsonRequest('PUT', '/api/chat-sections/order', { ids }, headers)))
					.status

			expect(await send([a.id])).toBe(400)
			expect(await send([a.id, a.id])).toBe(400)
			expect(await send([a.id, b.id, crypto.randomUUID()])).toBe(400)
			expect(await send([b.id, a.id])).toBe(200)
		})

		it('takes no owner from the request: an actor_id in the body changes nothing', async () => {
			const res = await as(me).request(
				jsonRequest('POST', '/api/chat-sections', { name: 'Mine', actor_id: other }, headers),
			)
			expect(res.status).toBe(201)
			const [row] = await db
				.select()
				.from(chatSections)
				.where(eq(chatSections.workspaceId, workspaceId))
			expect(row?.actorId).toBe(me)
			expect(await listSections(other)).toEqual([])
		})
	})

	describe('names', () => {
		it('keeps a name unique per person, whatever the capitalisation, and lets two people share one', async () => {
			expect((await createSection(me, 'Work')).status).toBe(201)
			expect((await createSection(me, 'work')).status).toBe(409)
			expect((await createSection(other, 'Work')).status).toBe(201)

			const home = (await createSection(me, 'Home')).body
			const clash = await as(me).request(
				jsonRequest('PATCH', `/api/chat-sections/${home.id}`, { name: 'WORK' }, headers),
			)
			expect(clash.status).toBe(409)
		})

		it('rejects a blank name and an over-long one, in the route and in the table', async () => {
			expect((await createSection(me, '   ')).status).toBe(400)
			expect((await createSection(me, 'x'.repeat(61))).status).toBe(400)
			await expect(
				db.insert(chatSections).values({ workspaceId, actorId: me, name: '  ', position: 0 }),
			).rejects.toThrow()
		})
	})

	describe('chats in sections', () => {
		it('puts a chat in one section at a time: moving it takes it out of the first', async () => {
			const work = (await createSection(me, 'Work')).body
			const home = (await createSection(me, 'Home')).body
			const chatId = await seedChat('a chat')

			expect((await putChat(me, work.id, chatId)).status).toBe(200)
			expect((await putChat(me, home.id, chatId)).status).toBe(200)

			const sections = await listSections(me)
			expect(sections.find((s) => s.id === work.id)?.conversationIds).toEqual([])
			expect(sections.find((s) => s.id === home.id)?.conversationIds).toEqual([chatId])

			const rows = await db
				.select()
				.from(chatSectionItems)
				.where(and(eq(chatSectionItems.actorId, me), eq(chatSectionItems.conversationId, chatId)))
			expect(rows).toHaveLength(1)
		})

		it('lets each person file the same chat in their own section', async () => {
			const mine = (await createSection(me, 'Mine')).body
			const theirs = (await createSection(other, 'Theirs')).body
			const chatId = await seedChat('both are in this')

			expect((await putChat(me, mine.id, chatId)).status).toBe(200)
			expect((await putChat(other, theirs.id, chatId)).status).toBe(200)

			expect((await listSections(me))[0]?.conversationIds).toEqual([chatId])
			expect((await listSections(other))[0]?.conversationIds).toEqual([chatId])
		})

		it('takes a chat out of a section, and only out of that section', async () => {
			const work = (await createSection(me, 'Work')).body
			const home = (await createSection(me, 'Home')).body
			const chatId = await seedChat('a chat')
			await putChat(me, home.id, chatId)

			// Asking to remove it from Work, where it is not, leaves it in Home.
			const notThere = await as(me).request(
				jsonRequest('DELETE', `/api/chat-sections/${work.id}/chats/${chatId}`, undefined, headers),
			)
			expect(notThere.status).toBe(200)
			expect((await listSections(me)).find((s) => s.id === home.id)?.conversationIds).toEqual([
				chatId,
			])

			const removed = await as(me).request(
				jsonRequest('DELETE', `/api/chat-sections/${home.id}/chats/${chatId}`, undefined, headers),
			)
			expect(removed.status).toBe(200)
			expect((await listSections(me)).find((s) => s.id === home.id)?.conversationIds).toEqual([])
		})

		it('refuses a chat the caller is not in, or has left, or that is in another workspace', async () => {
			const work = (await createSection(me, 'Work')).body
			const notMine = await seedChat('not mine', [other])
			const left = await seedChat('left')
			await db
				.update(conversationParticipants)
				.set({ leftAt: new Date() })
				.where(
					and(
						eq(conversationParticipants.conversationId, left),
						eq(conversationParticipants.actorId, me),
					),
				)
			const elsewhereWorkspace = (await insertWorkspace(db, me)).id
			const elsewhere = await insertConversation(db, elsewhereWorkspace, me, { title: 'elsewhere' })
			await db
				.insert(conversationParticipants)
				.values({ conversationId: elsewhere.id, actorId: me })

			for (const chatId of [notMine, left, elsewhere.id, crypto.randomUUID()]) {
				expect((await putChat(me, work.id, chatId)).status).toBe(404)
			}
			expect((await listSections(me))[0]?.conversationIds).toEqual([])
		})

		it('drops a chat from the section without an error when the person loses it or archives it', async () => {
			const work = (await createSection(me, 'Work')).body
			const stays = await seedChat('stays')
			const leaves = await seedChat('leaves')
			const archived = await seedChat('archived')
			for (const chatId of [stays, leaves, archived]) await putChat(me, work.id, chatId)

			await db
				.update(conversationParticipants)
				.set({ leftAt: new Date() })
				.where(
					and(
						eq(conversationParticipants.conversationId, leaves),
						eq(conversationParticipants.actorId, me),
					),
				)
			await db
				.update(conversationParticipants)
				.set({ archived: true })
				.where(
					and(
						eq(conversationParticipants.conversationId, archived),
						eq(conversationParticipants.actorId, me),
					),
				)

			expect((await listSections(me))[0]?.conversationIds).toEqual([stays])

			// The row is kept, so the chat is back in its section when the person is added again.
			await db
				.update(conversationParticipants)
				.set({ leftAt: null })
				.where(
					and(
						eq(conversationParticipants.conversationId, leaves),
						eq(conversationParticipants.actorId, me),
					),
				)
			expect((await listSections(me))[0]?.conversationIds).toContain(leaves)
		})

		it('orders a section’s chats by newest message first', async () => {
			const work = (await createSection(me, 'Work')).body
			const older = await seedChat('older')
			const newer = await seedChat('newer')
			await db
				.update(conversations)
				.set({ lastMessageAt: new Date(Date.now() - 86_400_000) })
				.where(eq(conversations.id, older))
			await putChat(me, work.id, older)
			await putChat(me, work.id, newer)

			expect((await listSections(me))[0]?.conversationIds).toEqual([newer, older])
		})

		it('says which section a chat is in on the chat list and on the chat itself, for the caller only', async () => {
			const work = (await createSection(me, 'Work')).body
			const chatId = await seedChat('filed')
			await putChat(me, work.id, chatId)

			const listFor = async (actorId: string) => {
				const res = await as(actorId).request(jsonGet('/api/conversations?limit=100', headers))
				expect(res.status).toBe(200)
				const body = (await res.json()) as {
					conversations: Array<{ id: string; sectionId: string | null }>
				}
				return body.conversations.find((c) => c.id === chatId)?.sectionId
			}
			expect(await listFor(me)).toBe(work.id)
			expect(await listFor(other)).toBeNull()

			const detail = await as(me).request(jsonGet(`/api/conversations/${chatId}`, headers))
			expect(((await detail.json()) as { sectionId: string | null }).sectionId).toBe(work.id)
		})
	})

	describe('database rules', () => {
		it('refuses an item whose owner is not the section’s owner (composite foreign key)', async () => {
			const mine = (await createSection(me, 'Mine')).body
			const chatId = await seedChat('a chat')
			await expect(
				db
					.insert(chatSectionItems)
					.values({ sectionId: mine.id, conversationId: chatId, actorId: other }),
			).rejects.toThrow()
		})

		it('refuses a chat in two sections for one person (primary key)', async () => {
			const a = (await createSection(me, 'A')).body
			const b = (await createSection(me, 'B')).body
			const chatId = await seedChat('a chat')
			await db
				.insert(chatSectionItems)
				.values({ sectionId: a.id, conversationId: chatId, actorId: me })
			await expect(
				db
					.insert(chatSectionItems)
					.values({ sectionId: b.id, conversationId: chatId, actorId: me }),
			).rejects.toThrow()
		})

		it('deleting a section frees its chats and keeps them; deleting a chat keeps the section', async () => {
			const work = (await createSection(me, 'Work')).body
			const gone = await seedChat('deleted later')
			const kept = await seedChat('kept')
			await putChat(me, work.id, gone)
			await putChat(me, work.id, kept)

			await db
				.delete(conversationParticipants)
				.where(eq(conversationParticipants.conversationId, gone))
			await db.delete(conversations).where(eq(conversations.id, gone))
			expect(await db.select().from(chatSections).where(eq(chatSections.id, work.id))).toHaveLength(
				1,
			)
			expect(
				await db.select().from(chatSectionItems).where(eq(chatSectionItems.conversationId, gone)),
			).toHaveLength(0)

			const res = await as(me).request(
				jsonRequest('DELETE', `/api/chat-sections/${work.id}`, undefined, headers),
			)
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ deleted: true, conversationIds: [kept] })
			expect(
				await db.select().from(chatSectionItems).where(eq(chatSectionItems.sectionId, work.id)),
			).toHaveLength(0)
			expect(await db.select().from(conversations).where(eq(conversations.id, kept))).toHaveLength(
				1,
			)
		})
	})
})
