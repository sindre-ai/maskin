import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversationParticipants, workspaceMembers } from '@maskin/db/schema'
import { validationFailureHook } from '../../lib/errors'
import { insertActor, insertConversation, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: searchRoutes } = await import('../../routes/search')

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

function createSearchApp(actorId: string) {
	const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/search', searchRoutes)
	return app
}

interface Hit {
	kind: string
	id: string
	title: string
	type?: string
	snippet?: string
	updated_at: string
	score: number
}
interface SearchBody {
	results: Hit[]
	next_cursor?: string
	counts?: { objects: number; team: number; loops: number; capped: boolean }
}

describe('POST /api/search Integration', () => {
	let ownerId: string
	let workspaceId: string
	let app: ReturnType<typeof createSearchApp>

	beforeEach(async () => {
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
		app = createSearchApp(ownerId)
	})

	async function search(body: Record<string, unknown>, ws = workspaceId) {
		const res = await app.request(
			jsonRequest('POST', '/api/search', body, { 'x-workspace-id': ws }),
		)
		return { status: res.status, body: (await res.json()) as SearchBody }
	}

	const at = (iso: string) => new Date(iso)

	describe('ranking', () => {
		it('ranks exact title > prefix > all-tokens > partial > content-only', async () => {
			const contentOnly = await insertObject(db, workspaceId, ownerId, {
				title: 'Weekly notes',
				content: 'we discussed the roadmap review in detail',
				updatedAt: at('2026-03-01T00:00:00Z'),
			})
			const partial = await insertObject(db, workspaceId, ownerId, {
				title: 'Roadmap sketch',
				content: null,
				updatedAt: at('2026-02-01T00:00:00Z'),
			})
			const allTokens = await insertObject(db, workspaceId, ownerId, {
				title: 'Review of the Q3 roadmap',
				content: null,
				updatedAt: at('2026-01-01T00:00:00Z'),
			})
			const prefix = await insertObject(db, workspaceId, ownerId, {
				title: 'Roadmap review kickoff',
				content: null,
				updatedAt: at('2025-12-01T00:00:00Z'),
			})
			const exact = await insertObject(db, workspaceId, ownerId, {
				title: 'roadmap review',
				content: null,
				updatedAt: at('2025-11-01T00:00:00Z'),
			})

			const { status, body } = await search({ query: 'Roadmap Review', scope: 'objects' })
			expect(status).toBe(200)
			expect(body.results.map((r) => r.id)).toEqual([
				exact.id,
				prefix.id,
				allTokens.id,
				partial.id,
				contentOnly.id,
			])
			const scores = body.results.map((r) => r.score)
			expect([...scores].sort((a, b) => b - a)).toEqual(scores)
		})

		it('lets a title match beat a content-only match even when the content row is newer', async () => {
			await insertObject(db, workspaceId, ownerId, {
				title: 'Unrelated',
				content: 'pricing pricing pricing pricing',
				updatedAt: at('2026-06-01T00:00:00Z'),
			})
			const titled = await insertObject(db, workspaceId, ownerId, {
				title: 'Pricing',
				content: null,
				updatedAt: at('2020-01-01T00:00:00Z'),
			})
			const { body } = await search({ query: 'pricing', scope: 'objects' })
			expect(body.results[0]?.id).toBe(titled.id)
			expect(body.results[1]?.snippet).toContain('pricing')
			expect(body.results[0]?.snippet).toBeUndefined()
		})

		it('breaks score ties by recency (updated_at DESC), then id', async () => {
			const old = await insertObject(db, workspaceId, ownerId, {
				title: 'Alpha board',
				content: null,
				updatedAt: at('2025-01-01T00:00:00Z'),
			})
			const recent = await insertObject(db, workspaceId, ownerId, {
				title: 'Alpha board',
				content: null,
				updatedAt: at('2026-01-01T00:00:00Z'),
			})
			const { body } = await search({ query: 'alpha board', scope: 'objects' })
			expect(body.results.map((r) => r.id)).toEqual([recent.id, old.id])
		})

		it('keeps short queries meaningful', async () => {
			const q3 = await insertObject(db, workspaceId, ownerId, { title: 'Q3', content: null })
			await insertObject(db, workspaceId, ownerId, { title: 'Annual plan', content: null })
			const { body } = await search({ query: 'Q3', scope: 'objects' })
			expect(body.results.map((r) => r.id)).toEqual([q3.id])
		})
	})

	describe('LIKE wildcard escaping', () => {
		it('treats % and _ literally', async () => {
			const literal = await insertObject(db, workspaceId, ownerId, {
				title: 'Hit 100%_target',
				content: null,
			})
			await insertObject(db, workspaceId, ownerId, { title: 'Hit 1000 xtarget', content: null })
			const { body } = await search({ query: '%_target', scope: 'objects' })
			expect(body.results.map((r) => r.id)).toEqual([literal.id])
		})

		it('does not let a lone wildcard match everything', async () => {
			await insertObject(db, workspaceId, ownerId, { title: 'Something', content: null })
			const { status, body } = await search({ query: '%', scope: 'objects' })
			expect(status).toBe(200)
			expect(body.results).toEqual([])
		})
	})

	describe('pagination', () => {
		it('walks every row exactly once across pages (no duplicates, no gaps)', async () => {
			const ids: string[] = []
			// Mix of identical scores and identical timestamps to exercise every cursor tiebreak.
			for (let i = 0; i < 23; i++) {
				const o = await insertObject(db, workspaceId, ownerId, {
					title: i % 2 === 0 ? 'Sprint review' : `Sprint review notes ${i}`,
					content: null,
					updatedAt: at(`2026-01-${String((i % 5) + 1).padStart(2, '0')}T00:00:00Z`),
				})
				ids.push(o.id)
			}
			const seen: string[] = []
			let cursor: string | undefined
			let pages = 0
			do {
				const { status, body } = await search({
					query: 'sprint review',
					scope: 'objects',
					limit: 5,
					...(cursor ? { cursor } : {}),
				})
				expect(status).toBe(200)
				if (pages === 0) expect(body.counts?.objects).toBe(23)
				else expect(body.counts).toBeUndefined()
				seen.push(...body.results.map((r) => r.id))
				cursor = body.next_cursor
				pages++
			} while (cursor && pages < 20)

			expect(pages).toBe(5)
			expect(new Set(seen).size).toBe(seen.length)
			expect([...seen].sort()).toEqual([...ids].sort())

			// The walk equals the single-page ordering.
			const { body: whole } = await search({ query: 'sprint review', scope: 'objects', limit: 50 })
			expect(seen).toEqual(whole.results.map((r) => r.id))
		})

		it('paginates across kinds in the all scope without duplicates', async () => {
			const other = await insertActor(db, { name: 'Nova Planner', type: 'agent' })
			await db.insert(workspaceMembers).values({ workspaceId, actorId: other.id, role: 'member' })
			await insertObject(db, workspaceId, ownerId, { title: 'Nova launch', content: null })
			await insertObject(db, workspaceId, ownerId, {
				title: 'Nova loop',
				type: 'loop',
				content: null,
			})
			const conv = await insertConversation(db, workspaceId, ownerId, { title: 'Nova chat' })
			await db
				.insert(conversationParticipants)
				.values({ conversationId: conv.id, actorId: ownerId })

			const seen: string[] = []
			let cursor: string | undefined
			let pages = 0
			do {
				const { body } = await search({ query: 'nova', limit: 1, ...(cursor ? { cursor } : {}) })
				seen.push(...body.results.map((r) => r.id))
				cursor = body.next_cursor
				pages++
			} while (cursor && pages < 10)
			expect(pages).toBe(4)
			expect(new Set(seen).size).toBe(4)
		})
	})

	describe('scopes', () => {
		it('objects scope excludes loops; loops scope returns only loops', async () => {
			const task = await insertObject(db, workspaceId, ownerId, {
				title: 'Onboarding task',
				content: null,
			})
			const loop = await insertObject(db, workspaceId, ownerId, {
				title: 'Onboarding loop',
				type: 'loop',
				content: null,
			})
			const objectsHits = await search({ query: 'onboarding', scope: 'objects' })
			expect(objectsHits.body.results.map((r) => r.id)).toEqual([task.id])
			const loopHits = await search({ query: 'onboarding', scope: 'loops' })
			expect(loopHits.body.results.map((r) => r.id)).toEqual([loop.id])
			expect(loopHits.body.results[0]?.type).toBe('loop')
			expect(loopHits.body.counts).toMatchObject({ objects: 1, loops: 1 })
		})

		it("team scope finds workspace actors by name and the caller's conversations by title only", async () => {
			const teammate = await insertActor(db, { name: 'Zephyra Quill', type: 'human' })
			await db
				.insert(workspaceMembers)
				.values({ workspaceId, actorId: teammate.id, role: 'member' })
			const outsider = await insertActor(db, { name: 'Zephyra Outsider', type: 'human' })

			const mine = await insertConversation(db, workspaceId, ownerId, { title: 'Zephyra standup' })
			await db
				.insert(conversationParticipants)
				.values({ conversationId: mine.id, actorId: ownerId })
			const notMine = await insertConversation(db, workspaceId, teammate.id, {
				title: 'Zephyra private',
			})
			await db
				.insert(conversationParticipants)
				.values({ conversationId: notMine.id, actorId: teammate.id })

			const { body } = await search({ query: 'zephyra', scope: 'team' })
			const ids = body.results.map((r) => r.id)
			expect(ids).toContain(teammate.id)
			expect(ids).toContain(mine.id)
			expect(ids).not.toContain(outsider.id)
			expect(ids).not.toContain(notMine.id)
			expect(body.results.find((r) => r.id === teammate.id)).toMatchObject({
				kind: 'actor',
				title: 'Zephyra Quill',
				type: 'human',
			})
			expect(body.counts?.team).toBe(2)
		})

		it('hides archived objects unless include_archived is set', async () => {
			const archived = await insertObject(db, workspaceId, ownerId, {
				title: 'Legacy migration',
				status: 'archived',
				content: null,
			})
			expect((await search({ query: 'legacy', scope: 'objects' })).body.results).toEqual([])
			const withArchived = await search({
				query: 'legacy',
				scope: 'objects',
				include_archived: true,
			})
			expect(withArchived.body.results.map((r) => r.id)).toEqual([archived.id])
		})

		it('filters the objects scope by object_type', async () => {
			const task = await insertObject(db, workspaceId, ownerId, {
				title: 'Budget task',
				type: 'task',
				content: null,
			})
			await insertObject(db, workspaceId, ownerId, {
				title: 'Budget bet',
				type: 'bet',
				content: null,
			})
			const { body } = await search({ query: 'budget', scope: 'objects', object_type: 'task' })
			expect(body.results.map((r) => r.id)).toEqual([task.id])
		})
	})

	describe('workspace scoping', () => {
		it("never returns another workspace's objects, actors or conversations", async () => {
			const otherActor = await insertActor(db, { type: 'human' })
			const otherWs = (await insertWorkspace(db, otherActor.id)).id
			await insertObject(db, otherWs, otherActor.id, { title: 'Secret roadmap', content: null })
			await insertObject(db, otherWs, otherActor.id, {
				title: 'Secret loop',
				type: 'loop',
				content: null,
			})
			const conv = await insertConversation(db, otherWs, otherActor.id, { title: 'Secret chat' })
			await db
				.insert(conversationParticipants)
				.values({ conversationId: conv.id, actorId: otherActor.id })
			const mine = await insertObject(db, workspaceId, ownerId, {
				title: 'Secret plan',
				content: null,
			})

			const { body } = await search({ query: 'secret' })
			expect(body.results.map((r) => r.id)).toEqual([mine.id])
			expect(body.counts).toMatchObject({ objects: 1, loops: 0, team: 0 })
		})
	})

	it('rejects a malformed cursor with 400', async () => {
		const { status } = await search({ query: 'x', cursor: 'bogus' })
		expect(status).toBe(400)
	})
})
