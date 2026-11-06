import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import * as schema from '@maskin/db/schema'
import { conversationParticipants, messages, workspaceMembers } from '@maskin/db/schema'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createApiError, formatZodError } from '../../lib/errors'
import {
	insertActor,
	insertConversation,
	insertSession,
	insertSessionLog,
	insertWorkspace,
} from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId, sql } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

/**
 * GET /api/conversations used to run one latest-message query per row and one log lookup per
 * running chat session, so a page of 30 chats cost about 34 queries. The count must now be the
 * same however many rows the page holds, and the rows must be what they were.
 */

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

function createApp(actorId: string, appDb: Database) {
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
		c.set('db', appDb)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return app
}

type ListRow = {
	id: string
	snippet: string | null
	snippet_actor_id: string | null
	snippet_actor_name: string | null
	working_actor_ids: string[]
}

describe('GET /api/conversations query count', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string

	beforeEach(async () => {
		humanId = getTestActorId()
		const ws = await insertWorkspace(db, humanId)
		if (!ws) throw new Error('failed to seed workspace')
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent' })
		if (!agent) throw new Error('failed to seed agent')
		agentId = agent.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agentId, role: 'member' })
	})

	/**
	 * A chat the caller is in. Newest to oldest: a helper result and a hidden nudge (neither may be
	 * the preview), then the visible message the preview must show. With `working`, the agent also
	 * has a running chat session with an open turn.
	 */
	async function seedChat(label: string, working: boolean) {
		const conversation = await insertConversation(db, workspaceId, humanId, { title: label })
		if (!conversation) throw new Error('failed to seed conversation')
		await db.insert(conversationParticipants).values([
			{ conversationId: conversation.id, actorId: humanId },
			{ conversationId: conversation.id, actorId: agentId },
		])
		await db.insert(messages).values({
			conversationId: conversation.id,
			actorId: agentId,
			content: `${label} visible`,
		})
		await db.insert(messages).values({
			conversationId: conversation.id,
			actorId: agentId,
			content: `${label} helper result`,
			metadata: { helper_return: 'x' },
		})
		await db.insert(messages).values({
			conversationId: conversation.id,
			actorId: humanId,
			content: `${label} nudge`,
			metadata: { hidden_from_chat: 'true' },
		})
		if (working) {
			const session = await insertSession(db, workspaceId, agentId, humanId, {
				conversationId: conversation.id,
				status: 'running',
				interactive: true,
			})
			await insertSessionLog(db, session.id, { content: '{"type":"assistant","message":{}}' })
		}
		return conversation
	}

	async function listWithCount() {
		const captured: string[] = []
		const loggedDb = drizzle(sql, {
			schema,
			logger: { logQuery: (query) => captured.push(query) },
		}) as unknown as Database
		const res = await createApp(humanId, loggedDb).request(
			jsonGet('/api/conversations?limit=50', { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { conversations: ListRow[] }
		return { rows: body.conversations, queries: captured.length }
	}

	it('issues the same number of queries for 2 chats as for 12, with unchanged rows', async () => {
		const small = [await seedChat('a0', true), await seedChat('a1', false)]
		const smallRun = await listWithCount()

		const more = []
		for (let i = 2; i < 12; i++) more.push(await seedChat(`a${i}`, i % 2 === 0))
		const largeRun = await listWithCount()

		expect(largeRun.queries).toBe(smallRun.queries)
		// Was about 3 + one per row + one per running chat session; now a fixed handful.
		expect(largeRun.queries).toBeLessThanOrEqual(8)

		expect(largeRun.rows).toHaveLength(12)
		for (const chat of [...small, ...more]) {
			const row = largeRun.rows.find((r) => r.id === chat.id)
			expect(row?.snippet).toBe(`${chat.title} visible`)
			expect(row?.snippet_actor_id).toBe(agentId)
			expect(row?.snippet_actor_name).toBeTruthy()
		}
		// Chats a0, a2, a4... had a running session with an open turn.
		const workingTitles = largeRun.rows
			.filter((r) => r.working_actor_ids.length > 0)
			.map((r) => r.snippet?.replace(' visible', ''))
			.sort()
		expect(workingTitles).toEqual(['a0', 'a10', 'a2', 'a4', 'a6', 'a8'])
	})
})
