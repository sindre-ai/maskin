// Search frecency: opens recorded from search lift a result for the person who opened it, decay
// with a 14 day half-life and are capped. Pinned against real Postgres because the bonus is SQL.

import { authMiddleware } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { conversationParticipants, conversations, messages, searchOpens } from '@maskin/db/schema'
import type { SearchQuery } from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import {
	ensureWorkspaceMember,
	insertActor,
	insertConversation,
	insertWorkspace,
} from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: searchRoutes } = await import('../../routes/search')
const { runSearch } = await import('../../services/search')
const { recordSearchOpen } = await import('../../services/search-opens')
const { FRECENCY_MAX_BONUS, FRECENCY_POINTS_PER_OPEN } = await import('../../lib/search-rank')

const TEST_API_KEY = 'ank_testintegration'
const DAY_MS = 24 * 60 * 60 * 1000

function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
	return { sort: 'rel', limit: 150, ...overrides }
}

describe('search frecency against real Postgres', () => {
	let workspaceId: string
	let actorId: string
	let otherUserId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		otherUserId = (await insertActor(db, { name: 'Other Person' })).id
		workspaceId = (await insertWorkspace(db, actorId)).id
		await ensureWorkspaceMember(db, workspaceId, otherUserId)
	})

	const search = (q: string, callerId = actorId) =>
		runSearch(db, { workspaceId, callerId }, query({ q }))

	/** A chat both people are in with one message, so `minutesAgo` orders the chats by recency. */
	async function seedChat(title: string, minutesAgo: number) {
		const chat = await insertConversation(db, workspaceId, actorId, { title })
		await db.insert(conversationParticipants).values([
			{ conversationId: chat.id, actorId },
			{ conversationId: chat.id, actorId: otherUserId },
		])
		await db.insert(messages).values({ conversationId: chat.id, actorId, content: 'hello' })
		await db
			.update(conversations)
			.set({ lastMessageAt: sql`now() - ${minutesAgo} * interval '1 minute'` })
			.where(eq(conversations.id, chat.id))
		return chat
	}

	/** Writes a decayed open count as if it was last current `daysAgo` days ago. */
	async function setOpens(entityId: string, decayedOpens: number, daysAgo = 0, callerId = actorId) {
		await db
			.insert(searchOpens)
			.values({
				workspaceId,
				actorId: callerId,
				entityId,
				decayedOpens,
				lastOpenedAt: new Date(Date.now() - daysAgo * DAY_MS),
			})
			.onConflictDoUpdate({
				target: [searchOpens.workspaceId, searchOpens.actorId, searchOpens.entityId],
				set: { decayedOpens, lastOpenedAt: new Date(Date.now() - daysAgo * DAY_MS) },
			})
	}

	const ids = async (q: string, callerId = actorId) =>
		(await search(q, callerId)).results.map((r) => r.id)

	it('ranks a chat opened twice above an otherwise equal, newer chat', async () => {
		// Same tier, same score; "older" is the opened one, "newer" wins on recency without opens.
		const older = await seedChat('Plan alpha', 30)
		const newer = await seedChat('Plan bravo', 1)
		expect(await ids('plan')).toEqual([newer.id, older.id])

		await recordSearchOpen(db, { workspaceId, actorId, entityId: older.id })
		await recordSearchOpen(db, { workspaceId, actorId, entityId: older.id })

		expect(await ids('plan')).toEqual([older.id, newer.id])
	})

	it('adds nothing for an empty query, so a plain list keeps its order', async () => {
		const older = await seedChat('Plan alpha', 30)
		const newer = await seedChat('Plan bravo', 1)
		await setOpens(older.id, 5)

		const res = await runSearch(db, { workspaceId, callerId: actorId }, query({ types: ['chat'] }))
		expect(res.results.map((r) => r.id).slice(0, 2)).toEqual([newer.id, older.id])
	})

	it('halves the stored count every 14 days when the row is read', async () => {
		// Fresh: one open (50 points). 28 days old: three opens decay to 0.75 (37 points).
		const fresh = await seedChat('Plan alpha', 30)
		const stale = await seedChat('Plan bravo', 1)
		await setOpens(fresh.id, 1, 0)
		await setOpens(stale.id, 3, 28)
		expect(await ids('plan')).toEqual([fresh.id, stale.id])

		// Three opens 14 days old are worth 1.5 (75 points): now they win.
		await setOpens(stale.id, 3, 14)
		expect(await ids('plan')).toEqual([stale.id, fresh.id])
	})

	it('records each open on top of the decayed old count', async () => {
		const chat = await seedChat('Plan alpha', 1)
		await setOpens(chat.id, 2, 14)

		await recordSearchOpen(db, { workspaceId, actorId, entityId: chat.id })

		const [row] = await db
			.select()
			.from(searchOpens)
			.where(and(eq(searchOpens.workspaceId, workspaceId), eq(searchOpens.entityId, chat.id)))
		// 2 opens halved once (14 days) is 1, plus the new open.
		expect(row?.decayedOpens).toBeGreaterThan(1.99)
		expect(row?.decayedOpens).toBeLessThan(2.01)
		expect(Date.now() - (row?.lastOpenedAt.getTime() ?? 0)).toBeLessThan(60_000)
	})

	it('caps the bonus, so a huge count ranks like a capped one', async () => {
		expect(FRECENCY_POINTS_PER_OPEN * 100).toBeGreaterThan(FRECENCY_MAX_BONUS)
		// Both are over the cap (3 opens = 150 points is exactly the cap). Equal bonus, so the newer
		// chat leads: a count of 1000 does not push the older one up.
		const older = await seedChat('Plan alpha', 30)
		const newer = await seedChat('Plan bravo', 1)
		await setOpens(older.id, 1000)
		await setOpens(newer.id, 3)
		expect(await ids('plan')).toEqual([newer.id, older.id])
	})

	it('never lets opens beat a better match tier', async () => {
		const whole = await seedChat('Plan room', 60)
		const inside = await seedChat('Xplanx room', 1)
		await setOpens(inside.id, 1000)
		expect(await ids('plan')).toEqual([whole.id, inside.id])
	})

	it('reads only the caller own history', async () => {
		const older = await seedChat('Plan alpha', 30)
		const newer = await seedChat('Plan bravo', 1)
		await setOpens(older.id, 5, 0, otherUserId)

		expect(await ids('plan')).toEqual([newer.id, older.id])
		expect(await ids('plan', otherUserId)).toEqual([older.id, newer.id])
	})

	describe('POST /api/search/opens', () => {
		function createApp() {
			const app = new Hono<{ Variables: { db: Database; actorId: string; actorType: string } }>()
			app.use('*', async (c, next) => {
				c.set('db', db)
				await next()
			})
			app.use('*', authMiddleware(db))
			app.route('/api/search', searchRoutes)
			return app
		}
		const auth = { Authorization: `Bearer ${TEST_API_KEY}` }

		it('records an open for the caller and answers 204', async () => {
			const chat = await seedChat('Plan alpha', 1)
			const res = await createApp().request(
				jsonRequest(
					'POST',
					'/api/search/opens',
					{ entity_id: chat.id },
					{ ...auth, 'X-Workspace-Id': workspaceId },
				),
			)
			expect(res.status).toBe(204)
			const rows = await db.select().from(searchOpens).where(eq(searchOpens.entityId, chat.id))
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({ workspaceId, actorId })
			expect(rows[0]?.decayedOpens).toBeCloseTo(1, 5)
		})

		it('rejects a body that is not a uuid', async () => {
			const res = await createApp().request(
				jsonRequest(
					'POST',
					'/api/search/opens',
					{ entity_id: 'nope' },
					{ ...auth, 'X-Workspace-Id': workspaceId },
				),
			)
			expect(res.status).toBe(400)
		})

		it('refuses a workspace the caller is not in', async () => {
			const stranger = await insertWorkspace(db, otherUserId)
			const res = await createApp().request(
				jsonRequest(
					'POST',
					'/api/search/opens',
					{ entity_id: crypto.randomUUID() },
					{ ...auth, 'X-Workspace-Id': stranger.id },
				),
			)
			expect(res.status).not.toBe(204)
			const rows = await db
				.select()
				.from(searchOpens)
				.where(eq(searchOpens.workspaceId, stranger.id))
			expect(rows).toHaveLength(0)
		})
	})
})
