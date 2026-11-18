// GET /api/search?operators=true: the chat list's search filters (agent, from, with, team, is,
// quoted phrases, minus words) against real Postgres. The SQL uses correlated subqueries, so a
// mocked DB cannot pin it (known-pitfalls.md).

import { authMiddleware } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { conversationParticipants, conversations, messages } from '@maskin/db/schema'
import type { SearchResponse } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
	ensureWorkspaceMember,
	insertActor,
	insertConversation,
	insertWorkspace,
} from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: searchRoutes } = await import('../../routes/search')

const TEST_API_KEY = 'ank_testintegration'

describe('GET /api/search with operators', () => {
	let workspaceId: string
	let callerId: string
	let forgeId: string
	let scoutId: string
	let sebastianId: string

	beforeEach(async () => {
		callerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, callerId)).id
		forgeId = (await insertActor(db, { type: 'agent', name: 'Forge' })).id
		scoutId = (await insertActor(db, { type: 'agent', name: 'Scout' })).id
		sebastianId = (await insertActor(db, { name: 'Sebastian' })).id
		for (const id of [forgeId, scoutId, sebastianId]) {
			await ensureWorkspaceMember(db, workspaceId, id)
		}
		await seedChat(
			'Launch plan',
			[forgeId, sebastianId],
			[
				{ from: callerId, text: 'what is the launch date' },
				{ from: forgeId, text: 'Friday, draft attached' },
			],
			{ tags: ['Sales'], read: true },
		)
		await seedChat(
			'Pricing',
			[scoutId],
			[
				{ from: callerId, text: 'pricing ideas' },
				{ from: scoutId, text: 'three options for pricing' },
			],
			{ tags: ['Growth'] },
		)
		await seedChat('Old notes', [forgeId], [{ from: forgeId, text: 'notes from the offsite' }], {
			archived: true,
		})
	})

	async function seedChat(
		title: string,
		others: string[],
		lines: Array<{ from: string; text: string; metadata?: object }>,
		opts: { tags?: string[]; archived?: boolean; read?: boolean } = {},
	) {
		const chat = await insertConversation(db, workspaceId, callerId, {
			title,
			tags: opts.tags ?? [],
		})
		await db
			.insert(conversationParticipants)
			.values([
				{ conversationId: chat.id, actorId: callerId, archived: opts.archived ?? false },
				...others.map((actorId) => ({ conversationId: chat.id, actorId })),
			])
		let last = 0
		for (const line of lines) {
			const [row] = await db
				.insert(messages)
				.values({
					conversationId: chat.id,
					actorId: line.from,
					content: line.text,
					metadata: line.metadata ?? null,
				})
				.returning()
			last = row?.id ?? last
		}
		await db
			.update(conversations)
			.set({ lastMessageAt: new Date() })
			.where(eq(conversations.id, chat.id))
		if (opts.read) {
			await db
				.update(conversationParticipants)
				.set({ lastReadMessageId: last })
				.where(eq(conversationParticipants.conversationId, chat.id))
		}
		return chat.id
	}

	// The chat list asks for every status, so archived chats are searchable like the rest.
	const EVERY_STATUS = 'needs_you,in_progress,new,done,archived'

	async function titles(q: string, statuses: string | null = EVERY_STATUS) {
		const app = new Hono<{ Variables: { db: Database; actorId: string; actorType: string } }>()
		app.use('*', async (c, next) => {
			c.set('db', db)
			await next()
		})
		app.use('*', authMiddleware(db))
		app.route('/api/search', searchRoutes)
		const res = await app.request(
			jsonGet(
				`/api/search?operators=true&q=${encodeURIComponent(q)}${statuses ? `&statuses=${statuses}` : ''}`,
				{
					Authorization: `Bearer ${TEST_API_KEY}`,
					'X-Workspace-Id': workspaceId,
				},
			),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as SearchResponse
		return body.results.map((r) => r.title).sort()
	}

	it('agent: needs an agent of that name in the chat', async () => {
		expect(await titles('agent:forge')).toEqual(['Launch plan', 'Old notes'])
		expect(await titles('agent:sebastian')).toEqual([])
	})

	it('with: takes any person or agent, never the caller', async () => {
		expect(await titles('with:sebastian')).toEqual(['Launch plan'])
		expect(await titles('with:scout')).toEqual(['Pricing'])
	})

	it('from: names who wrote in the chat, and understands me and agent', async () => {
		expect(await titles('from:forge')).toEqual(['Launch plan', 'Old notes'])
		expect(await titles('from:me')).toEqual(['Launch plan', 'Pricing'])
		expect(await titles('from:agent')).toEqual(['Launch plan', 'Old notes', 'Pricing'])
	})

	it('team: matches a tag of the chat', async () => {
		expect(await titles('team:sales')).toEqual(['Launch plan'])
		expect(await titles('team:growth pricing')).toEqual(['Pricing'])
	})

	it('is:unread and is:archived read the caller own state', async () => {
		expect(await titles('is:unread')).toEqual(['Old notes', 'Pricing'])
		expect(await titles('is:archived')).toEqual(['Old notes'])
	})

	it('is:archived finds archived chats even when the statuses would leave them out', async () => {
		expect(await titles('is:archived', 'needs_you')).toEqual(['Old notes'])
		expect(await titles('is:archived', null)).toEqual(['Old notes'])
	})

	it('joins filters and free words with AND', async () => {
		expect(await titles('agent:forge is:unread')).toEqual(['Old notes'])
		expect(await titles('agent:forge launch')).toEqual(['Launch plan'])
	})

	it('quoted phrases need the exact words, and minus words leave chats out', async () => {
		expect(await titles('"three options"')).toEqual(['Pricing'])
		expect(await titles('"options three"')).toEqual([])
		expect(await titles('agent:forge -offsite')).toEqual(['Launch plan'])
		expect(await titles('from:agent -"three options"')).toEqual(['Launch plan', 'Old notes'])
	})

	it('reads an unknown filter as plain text', async () => {
		expect(await titles('foo:bar')).toEqual([])
		expect(await titles('is:nonsense')).toEqual([])
	})

	it('is:needs and is:working use the chat own questions and sessions', async () => {
		const asked = await seedChat(
			'Needs an answer',
			[forgeId],
			[
				{
					from: forgeId,
					text: 'Which one?',
					metadata: {
						question: {
							session_id: crypto.randomUUID(),
							questions: [
								{
									question: 'Which one?',
									header: 'Pick',
									multi_select: false,
									options: [{ label: 'a' }, { label: 'b' }],
								},
							],
						},
					},
				},
			],
		)
		expect(asked).toBeTruthy()
		expect(await titles('is:needs')).toEqual(['Needs an answer'])
		expect(await titles('is:working')).toEqual([])
	})
})
