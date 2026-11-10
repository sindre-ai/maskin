import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversationParticipants, conversations, workspaceMembers } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { directPairKey } from '../../services/direct-chat'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

function appFor(actorId: string) {
	const app = new OpenAPIHono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return app
}

interface ListedChat {
	id: string
	title: string
	directPairKey: string | null
}

describe('direct messages between people', () => {
	let workspaceId: string
	let a: { id: string; name: string }
	let b: { id: string; name: string }
	let c: { id: string; name: string }

	const list = async (actorId: string) => {
		const res = await appFor(actorId).request(
			jsonGet('/api/conversations', { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		return ((await res.json()) as { conversations: ListedChat[] }).conversations
	}

	const pairRows = async () =>
		db
			.select({ id: conversations.id, key: conversations.directPairKey })
			.from(conversations)
			.where(
				and(
					eq(conversations.workspaceId, workspaceId),
					inArray(conversations.directPairKey, [
						directPairKey(a.id, b.id),
						directPairKey(a.id, c.id),
						directPairKey(b.id, c.id),
					]),
				),
			)

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const people = []
		for (const name of ['Ada Person', 'Bo Person', 'Cy Person']) {
			const actor = await insertActor(db, { type: 'human', name })
			await db.insert(workspaceMembers).values({ workspaceId, actorId: actor.id, role: 'member' })
			people.push({ id: actor.id, name })
		}
		;[a, b, c] = people as [typeof a, typeof b, typeof c]
	})

	it('gives a person a direct message with every other person, named after that person', async () => {
		const chats = await list(a.id)
		const direct = chats.filter((chat) => chat.directPairKey)
		const byKey = new Map(direct.map((chat) => [chat.directPairKey, chat.title]))
		expect(byKey.get(directPairKey(a.id, b.id))).toBe(b.name)
		expect(byKey.get(directPairKey(a.id, c.id))).toBe(c.name)
		// B and C have not opened their lists, so a third pair is not made on A's behalf.
		expect(byKey.has(directPairKey(b.id, c.id))).toBe(false)
	})

	it('makes all three pairs once each of the three has looked, and each sees the other name', async () => {
		await list(a.id)
		await list(b.id)
		await list(c.id)
		expect(await pairRows()).toHaveLength(3)

		const ada = (await list(a.id)).find((chat) => chat.directPairKey === directPairKey(a.id, b.id))
		const bo = (await list(b.id)).find((chat) => chat.directPairKey === directPairKey(a.id, b.id))
		expect(ada?.id).toBe(bo?.id)
		expect(ada?.title).toBe(b.name)
		expect(bo?.title).toBe(a.name)
	})

	it('does not make a second chat for a pair when the list is loaded again', async () => {
		await list(a.id)
		await list(a.id)
		await list(b.id)
		// A+B and A+C from A's list, B+C from B's: three chats, none twice.
		expect(await pairRows()).toHaveLength(3)
		const participants = await db
			.select({ id: conversationParticipants.conversationId })
			.from(conversationParticipants)
			.where(inArray(conversationParticipants.actorId, [a.id, b.id]))
		// A is in A+B and A+C, B is in A+B and B+C: four rows, so no pair got a second chat.
		expect(participants).toHaveLength(4)
	})

	it('names the direct message after the other person when it is opened by id', async () => {
		const ada = (await list(a.id)).find((chat) => chat.directPairKey === directPairKey(a.id, b.id))
		const res = await appFor(b.id).request(
			jsonGet(`/api/conversations/${ada?.id}`, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		expect(((await res.json()) as { title: string }).title).toBe(a.name)
	})
})
