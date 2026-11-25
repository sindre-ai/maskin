// One order for every chat search. The cases live in packages/shared/fixtures/chat-search-order.json,
// which the Swift tests read too (ChatSearchOrderTests), so the server and the phone cannot drift.

import { readFileSync } from 'node:fs'
import { conversationParticipants, conversations, messages } from '@maskin/db/schema'
import type { SearchQuery } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import {
	ensureWorkspaceMember,
	insertActor,
	insertConversation,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

const { runSearch } = await import('../../services/search')

interface FixtureChat {
	id: string
	title: string
	people: string[]
	archived: boolean
	unread: boolean
	minutesAgo: number
	message: string
}

interface Fixture {
	chats: FixtureChat[]
	cases: Array<{ query: string; expected: string[] }>
}

const fixture = JSON.parse(
	readFileSync(
		new URL('../../../../../packages/shared/fixtures/chat-search-order.json', import.meta.url),
		'utf8',
	),
) as Fixture

describe('chat search order (shared fixture)', () => {
	let workspaceId: string
	let viewerId: string
	/** Fixture id to the id of the chat row seeded for it. */
	const chatIds = new Map<string, string>()

	beforeEach(async () => {
		viewerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, viewerId)).id
		chatIds.clear()

		const actorIds = new Map<string, string>()
		for (const name of new Set(fixture.chats.flatMap((chat) => chat.people))) {
			const actor = await insertActor(db, { name })
			await ensureWorkspaceMember(db, workspaceId, actor.id)
			actorIds.set(name, actor.id)
		}

		for (const chat of fixture.chats) {
			const others = chat.people.map((name) => actorIds.get(name) as string)
			const row = await insertConversation(db, workspaceId, viewerId, { title: chat.title })
			chatIds.set(chat.id, row.id)
			await db
				.insert(conversationParticipants)
				.values([
					{ conversationId: row.id, actorId: viewerId, archived: chat.archived },
					...others.map((actorId) => ({ conversationId: row.id, actorId })),
				])
			// An unread chat ends on a message from someone else that the viewer has not read.
			await db.insert(messages).values({
				conversationId: row.id,
				actorId: chat.unread ? (others[0] as string) : viewerId,
				content: chat.message,
			})
			await db
				.update(conversations)
				.set({ lastMessageAt: new Date(Date.now() - chat.minutesAgo * 60_000) })
				.where(eq(conversations.id, row.id))
		}
	})

	const search = (q: string) => {
		const query: SearchQuery = {
			q,
			sort: 'rel',
			limit: 150,
			types: ['chat'],
			statuses: ['needs_you', 'in_progress', 'new', 'done', 'archived'],
		}
		return runSearch(db, { workspaceId, callerId: viewerId }, query)
	}

	for (const testCase of fixture.cases) {
		it(`orders the chats found by "${testCase.query}" as the fixture says`, async () => {
			const res = await search(testCase.query)
			const fixtureIdOf = new Map([...chatIds].map(([fixtureId, id]) => [id, fixtureId]))

			expect(res.results.map((r) => fixtureIdOf.get(r.id))).toEqual(testCase.expected)
		})
	}
})
