// GET /api/search: six sources, true counts and AND matching. The SQL here is
// new and uses correlated subqueries, so it is pinned against real Postgres
// (a mocked DB cannot catch unqualified-column bugs, see known-pitfalls.md).

import { authMiddleware } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	conversationParticipants,
	conversations,
	messages,
	objects,
	triggers,
} from '@maskin/db/schema'
import type { SearchQuery, SearchResponse } from '@maskin/shared'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import {
	buildObject,
	ensureWorkspaceMember,
	insertActor,
	insertConversation,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: searchRoutes } = await import('../../routes/search')
const { SEARCH_SOURCES, runSearch } = await import('../../services/search')

// The actor seeded in global-setup's beforeAll.
const TEST_API_KEY = 'ank_testintegration'

/** Lets the clock move on so two writes never share a millisecond. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 15))

function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
	return { sort: 'rel', limit: 150, ...overrides }
}

describe('GET /api/search against real Postgres', () => {
	let workspaceId: string
	let otherWorkspaceId: string
	let actorId: string
	let otherUserId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const other = await insertActor(db, { name: 'Other Person' })
		otherUserId = other.id
		workspaceId = (await insertWorkspace(db, actorId)).id
		otherWorkspaceId = (await insertWorkspace(db, actorId)).id
		await ensureWorkspaceMember(db, workspaceId, otherUserId)
	})

	const search = (overrides: Partial<SearchQuery> = {}, callerId = actorId) =>
		runSearch(db, { workspaceId, callerId }, query(overrides))

	async function seedObjects(
		type: string,
		status: string,
		count: number,
		title: (i: number) => string,
		workspace = workspaceId,
	) {
		const rows = Array.from({ length: count }, (_, i) =>
			buildObject({ workspaceId: workspace, createdBy: actorId, type, status, title: title(i) }),
		)
		for (let i = 0; i < rows.length; i += 100) {
			await db.insert(objects).values(rows.slice(i, i + 100))
		}
	}

	async function seedChat(
		title: string,
		participantIds: string[],
		overrides: Record<string, unknown> = {},
	) {
		const chat = await insertConversation(db, workspaceId, participantIds[0] as string, {
			title,
			...overrides,
		})
		await db.insert(conversationParticipants).values(
			participantIds.map((id) => ({
				conversationId: chat.id,
				actorId: id,
			})),
		)
		return chat
	}

	async function say(conversationId: string, from: string, content: string) {
		const [row] = await db
			.insert(messages)
			.values({ conversationId, actorId: from, content })
			.returning()
		await db
			.update(conversations)
			.set({ lastMessageAt: sql`now()` })
			.where(eq(conversations.id, conversationId))
		return row as { id: number }
	}

	it('counts every match above the cap and says the list was capped', async () => {
		await seedObjects('bet', 'active', 160, (i) => `widget bet ${i}`)

		const res = await search({ q: 'widget' })

		expect(res.total).toBe(160)
		expect(res.results).toHaveLength(150)
		expect(res.capped).toBe(true)
		expect(res.facets.types.bet).toBe(160)
	})

	it('counts past 20 objects and past 30 chats, the old browser limits', async () => {
		await seedObjects('task', 'todo', 45, (i) => `gadget task ${i}`)
		for (let i = 0; i < 35; i++) await seedChat(`gadget chat ${i}`, [actorId])

		const res = await search({ q: 'gadget', limit: 10 })

		expect(res.facets.types.task).toBe(45)
		expect(res.facets.types.chat).toBe(35)
		expect(res.total).toBe(80)
		expect(res.results).toHaveLength(10)
		expect(res.capped).toBe(true)
	})

	it('needs every typed word to match, not any of them', async () => {
		await seedObjects('company', 'customer', 1, () => 'Hans customer')
		await seedObjects('contact', 'qualified', 1, () => 'Hans only')
		await seedObjects('company', 'prospect', 1, () => 'Customer only')

		const both = await search({ q: 'hans customer' })
		expect(both.results.map((r) => r.title)).toEqual(['Hans customer'])
		expect(both.total).toBe(1)

		const one = await search({ q: 'hans' })
		expect(one.total).toBe(2)
	})

	it('matches short words and common words the objects search drops', async () => {
		await seedObjects('task', 'todo', 1, () => 'Fix the db')
		const res = await search({ q: 'db the' })
		expect(res.total).toBe(1)
	})

	it('reads LIKE wildcards in the query as plain characters', async () => {
		await seedObjects('task', 'todo', 1, () => '100% done')
		await seedObjects('task', 'todo', 1, () => 'Something else')
		expect((await search({ q: '%' })).total).toBe(1)
		expect((await search({ q: '_' })).total).toBe(0)
	})

	it('never returns another workspace or another users chat', async () => {
		await seedObjects('bet', 'active', 1, () => 'isolation bet')
		await seedObjects('bet', 'active', 3, () => 'isolation bet elsewhere', otherWorkspaceId)
		await seedChat('isolation mine', [actorId])
		await seedChat('isolation shared', [actorId, otherUserId])
		await seedChat('isolation private to other', [otherUserId])
		const left = await seedChat('isolation left', [actorId])
		await db
			.update(conversationParticipants)
			.set({ leftAt: new Date() })
			.where(eq(conversationParticipants.conversationId, left.id))

		const mine = await search({ q: 'isolation' })
		expect(mine.results.map((r) => r.title).sort()).toEqual([
			'isolation bet',
			'isolation mine',
			'isolation shared',
		])

		const theirs = await search({ q: 'isolation', types: ['chat'] }, otherUserId)
		expect(theirs.results.map((r) => r.title).sort()).toEqual([
			'isolation private to other',
			'isolation shared',
		])
	})

	it('finds a chat by participant name and by its latest message', async () => {
		const chat = await seedChat('Weekly sync', [actorId, otherUserId])
		await say(chat.id, otherUserId, 'the quarterly numbers look odd')
		await say(chat.id, otherUserId, 'please review the budget')

		// Chats only: the other user is also a member, so the people source finds them too.
		expect(
			(await search({ q: 'other person', types: ['chat'] })).results.map((r) => r.title),
		).toEqual(['Weekly sync'])
		expect((await search({ q: 'budget' })).total).toBe(1)
		// Only the latest message is searched.
		expect((await search({ q: 'quarterly' })).total).toBe(0)
		const [row] = (await search({ q: 'budget' })).results
		expect(row?.snippet).toBe('please review the budget')
	})

	it('cuts snippets to 160 characters', async () => {
		await seedObjects('knowledge', 'validated', 1, () => 'long body note')
		await db
			.update(objects)
			.set({ content: `long ${'x'.repeat(500)}` })
			.where(eq(objects.title, 'long body note'))
		const [row] = (await search({ q: 'long body' })).results
		expect(row?.snippet).toHaveLength(160)
	})

	describe('status groups and facets', () => {
		beforeEach(async () => {
			await seedObjects('bet', 'active', 3, (i) => `zeta bet ${i}`)
			await seedObjects('task', 'in_review', 2, (i) => `zeta review ${i}`)
			await seedObjects('task', 'done', 1, () => 'zeta done')
			await seedObjects('insight', 'new', 1, () => 'zeta insight')
		})

		it('counts types over the text only, so chips keep their numbers', async () => {
			const res = await search({ q: 'zeta', types: ['task'] })
			expect(res.total).toBe(3)
			expect(res.facets.types).toMatchObject({ bet: 3, task: 3, insight: 1, chat: 0, loop: 0 })
			expect(res.facets.types).toMatchObject({ agent: 0, automation: 0 })
		})

		it('counts statuses over the text plus the selected types', async () => {
			const res = await search({ q: 'zeta', types: ['task'] })
			expect(res.facets.statuses).toEqual({
				needs_you: 2,
				in_progress: 0,
				new: 0,
				done: 1,
				archived: 0,
			})
		})

		it('does not let the status filter change the status or type facets', async () => {
			const res = await search({ q: 'zeta', statuses: ['done'] })
			expect(res.total).toBe(1)
			expect(res.results[0]?.title).toBe('zeta done')
			expect(res.facets.statuses).toEqual({
				needs_you: 2,
				in_progress: 3,
				new: 1,
				done: 1,
				archived: 0,
			})
			expect(res.facets.types).toMatchObject({ bet: 3, task: 3, insight: 1 })
		})

		it('reports what dropping the filters would give', async () => {
			const res = await search({ q: 'zeta', types: ['task'], statuses: ['new'] })
			expect(res.total).toBe(0)
			expect(res.relaxed).toEqual({ withoutFilters: 7, withoutStatuses: 3 })
		})

		it('stamps the raw status and its group on every row', async () => {
			const res = await search({ q: 'zeta review' })
			expect(res.results.map((r) => [r.status, r.statusGroup])).toEqual([
				['in_review', 'needs_you'],
				['in_review', 'needs_you'],
			])
		})
	})

	it('hides archived rows unless the archived group is selected, but counts them in the chip', async () => {
		await seedObjects('bet', 'archived', 2, (i) => `omega old ${i}`)
		await seedObjects('bet', 'active', 1, () => 'omega live')
		await seedObjects('bet', 'paused', 1, () => 'omega paused')
		const archivedChat = await seedChat('omega chat archived', [actorId])
		await db
			.update(conversationParticipants)
			.set({ archived: true })
			.where(eq(conversationParticipants.conversationId, archivedChat.id))

		const hidden = await search({ q: 'omega' })
		expect(hidden.results.map((r) => r.title).sort()).toEqual(['omega live', 'omega paused'])
		expect(hidden.total).toBe(2)
		// Paused is not the literal archived status, so it stays visible; the chip shows the true count.
		expect(hidden.facets.statuses.archived).toBe(4)
		expect(hidden.relaxed.withoutFilters).toBe(2)

		const shown = await search({ q: 'omega', statuses: ['archived'] })
		expect(shown.total).toBe(4)
		expect(shown.results.map((r) => r.title).sort()).toEqual([
			'omega chat archived',
			'omega old 0',
			'omega old 1',
			'omega paused',
		])
	})

	it('filters on updated_after for every source', async () => {
		const agent = await insertActor(db, { type: 'agent', name: 'sigma agent', agentState: 'idle' })
		await ensureWorkspaceMember(db, workspaceId, agent.id)
		await insertTrigger(db, workspaceId, actorId, agent.id, { name: 'sigma automation' })
		await seedObjects('task', 'todo', 1, () => 'sigma task')
		await seedChat('sigma chat', [actorId])

		const before = await search({ q: 'sigma' })
		expect(before.total).toBe(4)

		const cutoff = new Date(Date.now() + 60_000)
		const none = await search({ q: 'sigma', updated_after: cutoff.toISOString() })
		expect(none.total).toBe(0)
		expect(none.results).toEqual([])

		const old = new Date(Date.now() - 3 * 24 * 3_600_000)
		await db.update(objects).set({ updatedAt: old }).where(eq(objects.title, 'sigma task'))
		await db.update(triggers).set({ updatedAt: old }).where(eq(triggers.name, 'sigma automation'))
		const recent = await search({
			q: 'sigma',
			updated_after: new Date(Date.now() - 24 * 3_600_000).toISOString(),
		})
		expect(recent.results.map((r) => r.title).sort()).toEqual(['sigma agent', 'sigma chat'])
		expect(recent.total).toBe(2)
		// The facets ignore the Updated filter.
		expect(recent.facets.types.task).toBe(1)
	})

	it('puts the just-edited object, automation, agent and chat first under recent sort', async () => {
		const agent = await insertActor(db, { type: 'agent', name: 'tau agent', agentState: 'idle' })
		await ensureWorkspaceMember(db, workspaceId, agent.id)
		await insertTrigger(db, workspaceId, actorId, agent.id, { name: 'tau automation' })
		await seedObjects('task', 'todo', 1, () => 'tau task')
		const chat = await seedChat('tau chat', [actorId])

		const day = 24 * 3_600_000
		const stamp = (days: number) => new Date(Date.now() - days * day)
		await db
			.update(objects)
			.set({ updatedAt: stamp(5) })
			.where(eq(objects.title, 'tau task'))
		await db
			.update(triggers)
			.set({ updatedAt: stamp(4) })
			.where(eq(triggers.name, 'tau automation'))
		await db.execute(sql`UPDATE actors SET updated_at = ${stamp(3).toISOString()}::timestamptz,
			agent_state_updated_at = NULL WHERE id = ${agent.id}`)
		await db
			.update(conversations)
			.set({ lastMessageAt: stamp(2) })
			.where(eq(conversations.id, chat.id))

		const sorted = await search({ q: 'tau', sort: 'recent' })
		expect(sorted.results.map((r) => r.title)).toEqual([
			'tau chat',
			'tau agent',
			'tau automation',
			'tau task',
		])

		// A new chat message moves the chat to the front again, an agent state change the agent.
		await tick()
		await db.update(objects).set({ updatedAt: new Date() }).where(eq(objects.title, 'tau task'))
		const touched = await search({ q: 'tau', sort: 'recent' })
		expect(touched.results[0]?.title).toBe('tau task')
		await tick()
		await say(chat.id, actorId, 'ping')
		const pinged = await search({ q: 'tau', sort: 'recent' })
		expect(pinged.results[0]?.title).toBe('tau chat')
		expect(pinged.results.every((r) => r.updatedAt !== null)).toBe(true)
		await tick()
		await db.execute(sql`UPDATE actors SET agent_state_updated_at = now() WHERE id = ${agent.id}`)
		expect((await search({ q: 'tau', sort: 'recent' })).results[0]?.title).toBe('tau agent')
	})

	it('sorts A to Z by title', async () => {
		await seedObjects('task', 'todo', 1, () => 'beta item')
		await seedObjects('task', 'todo', 1, () => 'Alpha item')
		await seedChat('gamma item', [actorId])
		const res = await search({ q: 'item', sort: 'az' })
		expect(res.results.map((r) => r.title)).toEqual(['Alpha item', 'beta item', 'gamma item'])
	})

	it('ranks title hits above body hits, in a fixed group order, under relevance sort', async () => {
		await seedObjects('task', 'todo', 1, () => 'unrelated')
		await db
			.update(objects)
			.set({ content: 'mentions kappa once' })
			.where(eq(objects.title, 'unrelated'))
		await seedObjects('task', 'todo', 1, () => 'kappa task')
		await seedChat('kappa chat', [actorId])
		const res = await search({ q: 'kappa' })
		expect(res.results.map((r) => r.group)).toEqual(['chats', 'objects', 'objects'])
		expect(res.results.map((r) => r.title)).toEqual(['kappa chat', 'kappa task', 'unrelated'])
	})

	it('derives chat status from the callers read position', async () => {
		const chat = await seedChat('status chat', [actorId, otherUserId])
		const message = await say(chat.id, otherUserId, 'hello')

		const unread = (await search({ q: 'status chat' })).results[0]
		expect([unread?.status, unread?.statusGroup]).toEqual(['unread', 'new'])

		await db
			.update(conversationParticipants)
			.set({ lastReadMessageId: message.id })
			.where(eq(conversationParticipants.conversationId, chat.id))
		const read = (await search({ q: 'status chat' })).results[0]
		expect([read?.status, read?.statusGroup]).toEqual(['read', 'done'])

		// The other users own message is never unread for them.
		const theirs = (await search({ q: 'status chat' }, otherUserId)).results[0]
		expect(theirs?.status).toBe('read')
	})

	it('maps agent state and automation enabled to status groups', async () => {
		const failed = await insertActor(db, {
			type: 'agent',
			name: 'psi failed',
			agentState: 'failed',
		})
		const running = await insertActor(db, {
			type: 'agent',
			name: 'psi running',
			agentState: 'running',
		})
		await ensureWorkspaceMember(db, workspaceId, failed.id)
		await ensureWorkspaceMember(db, workspaceId, running.id)
		await insertTrigger(db, workspaceId, actorId, running.id, { name: 'psi off', enabled: false })
		await insertTrigger(db, workspaceId, actorId, running.id, { name: 'psi on', enabled: true })
		// An agent in another workspace must not show.
		const stranger = await insertActor(db, { type: 'agent', name: 'psi stranger' })
		await ensureWorkspaceMember(db, otherWorkspaceId, stranger.id)

		const res = await search({ q: 'psi' })
		const byTitle = Object.fromEntries(res.results.map((r) => [r.title, r.statusGroup]))
		expect(byTitle).toEqual({
			'psi failed': 'needs_you',
			'psi running': 'in_progress',
			'psi on': 'in_progress',
			'psi off': 'archived',
		})
		expect(res.facets.statuses.archived).toBe(1)
	})

	describe('people', () => {
		let magnusId: string

		beforeEach(async () => {
			const magnus = await insertActor(db, { name: 'Magnus Nodegard', email: 'magnus@omega.test' })
			magnusId = magnus.id
			await ensureWorkspaceMember(db, workspaceId, magnusId)
		})

		it('finds a member by name in the people group, with the email as the sub line', async () => {
			const res = await search({ q: 'magnus' })
			expect(res.results).toHaveLength(1)
			expect(res.results[0]).toMatchObject({
				id: magnusId,
				group: 'people',
				type: 'person',
				title: 'Magnus Nodegard',
				sub: 'magnus@omega.test',
				status: 'member',
			})
			expect(res.facets.types.person).toBe(1)
		})

		it('matches the name in any word order and part of the email', async () => {
			const reversed = await search({ q: 'nodegard magnus' })
			expect(reversed.results.map((r) => r.id)).toEqual([magnusId])

			const byEmail = await search({ q: 'omega.test' })
			expect(byEmail.results.map((r) => r.id)).toEqual([magnusId])

			const nameAndEmail = await search({ q: 'nodegard omega' })
			expect(nameAndEmail.results.map((r) => r.id)).toEqual([magnusId])
		})

		it('never returns agents, people from other workspaces or people who are not members', async () => {
			const agent = await insertActor(db, { type: 'agent', name: 'Magnus Bot' })
			await ensureWorkspaceMember(db, workspaceId, agent.id)
			const elsewhere = await insertActor(db, { name: 'Magnus Elsewhere' })
			await ensureWorkspaceMember(db, otherWorkspaceId, elsewhere.id)
			await insertActor(db, { name: 'Magnus Outsider' })

			const res = await search({ q: 'magnus', types: ['person'] })
			expect(res.results.map((r) => r.id)).toEqual([magnusId])

			const all = await search({ q: 'magnus' })
			expect(all.results.map((r) => [r.group, r.title])).toEqual([
				['agents', 'Magnus Bot'],
				['people', 'Magnus Nodegard'],
			])
		})

		it('is hidden by any status filter and stays out of the status counts', async () => {
			const filtered = await search({ q: 'magnus', statuses: ['in_progress'] })
			expect(filtered.results).toEqual([])
			expect(filtered.total).toBe(0)

			const open = await search({ q: 'magnus' })
			expect(open.total).toBe(1)
			expect(open.facets.statuses).toEqual({
				needs_you: 0,
				in_progress: 0,
				new: 0,
				done: 0,
				archived: 0,
			})
			// Dropping the status filter would bring the person back.
			expect(filtered.relaxed).toEqual({ withoutFilters: 1, withoutStatuses: 1 })
		})

		it('counts under the person type chip and filters with it', async () => {
			await seedObjects('task', 'todo', 2, (i) => `magnus task ${i}`)

			const res = await search({ q: 'magnus' })
			expect(res.facets.types).toMatchObject({ person: 1, task: 2 })

			const onlyPeople = await search({ q: 'magnus', types: ['person'] })
			expect(onlyPeople.results.map((r) => r.group)).toEqual(['people'])
			expect(onlyPeople.total).toBe(1)
		})

		it('lists people before objects under relevance sort', async () => {
			await seedObjects('task', 'todo', 1, () => 'Magnus task')
			const res = await search({ q: 'magnus' })
			expect(res.results.map((r) => r.group)).toEqual(['people', 'objects'])
		})
	})

	it('lists loops under their own group and type', async () => {
		await seedObjects('loop', 'live', 1, () => 'rho loop')
		await seedObjects('task', 'todo', 1, () => 'rho task')
		const res = await search({ q: 'rho', types: ['loop'] })
		expect(res.results.map((r) => [r.group, r.type])).toEqual([['loops', 'loop']])
		expect(res.facets.types).toMatchObject({ loop: 1, task: 1 })
	})

	it('answers 200 with the failed source in partial when one source breaks', async () => {
		await seedObjects('task', 'todo', 2, (i) => `lambda task ${i}`)
		await seedChat('lambda chat', [actorId])
		const sources = SEARCH_SOURCES.map((source) =>
			source.key === 'automations'
				? { ...source, candidates: () => sql`SELECT * FROM table_that_does_not_exist` }
				: source,
		)

		const res = await runSearch(
			db,
			{ workspaceId, callerId: actorId },
			query({ q: 'lambda' }),
			sources,
		)

		expect(res.partial).toEqual(['automations'])
		expect(res.total).toBe(3)
		expect(res.facets.types.automation).toBeUndefined()
		expect(res.facets.types.task).toBe(2)
	})

	describe('second pass for typos', () => {
		it('finds an object, an agent and a chat by a one-letter typo of the title', async () => {
			await seedObjects('task', 'todo', 1, () => 'Quarterly roadmap')
			const agent = await insertActor(db, { type: 'agent', name: 'Magnus helper' })
			await ensureWorkspaceMember(db, workspaceId, agent.id)
			await seedChat('Budget review', [actorId])

			expect((await search({ q: 'qaurterly' })).results.map((r) => r.title)).toEqual([
				'Quarterly roadmap',
			])
			const byAgent = await search({ q: 'mgnus' })
			expect(byAgent.results.map((r) => [r.group, r.title])).toEqual([['agents', 'Magnus helper']])
			expect((await search({ q: 'budgat' })).results.map((r) => r.title)).toEqual(['Budget review'])
		})

		it('counts the hits in total and facets, and puts them below exact hits', async () => {
			await seedObjects('task', 'todo', 1, () => 'Magnus plan')
			await tick()
			// Newer than the exact hit, so recency alone would put it first.
			await seedObjects('task', 'todo', 1, () => 'Mgnus note')

			const res = await search({ q: 'magnus' })

			expect(res.results.map((r) => r.title)).toEqual(['Magnus plan', 'Mgnus note'])
			expect(res.total).toBe(2)
			expect(res.facets.types.task).toBe(2)
			expect(res.facets.statuses.new).toBe(2)
			expect(res.capped).toBe(false)
			expect(res.partial).toEqual([])
		})

		it('lists the closest spelling first among typo hits', async () => {
			await seedObjects('task', 'todo', 1, () => 'Quarterlyy plan')
			await seedObjects('task', 'todo', 1, () => 'Qarterly plan')
			await seedObjects('task', 'todo', 1, () => 'Quarterly plan')

			const res = await search({ q: 'quartrly' })

			expect(res.results).toHaveLength(3)
			expect(res.results[0]?.title).toBe('Quarterly plan')
		})

		it('does not run when the strict search found enough rows', async () => {
			await seedObjects('task', 'todo', 5, (i) => `widget task ${i}`)
			await seedObjects('task', 'todo', 1, () => 'widgte typo')

			const res = await search({ q: 'widget' })

			expect(res.total).toBe(5)
			expect(res.results.map((r) => r.title)).not.toContain('widgte typo')
		})

		it('does not forgive typos in words of three letters or fewer', async () => {
			await seedObjects('task', 'todo', 1, () => 'cut the cord')
			expect((await search({ q: 'cat' })).total).toBe(0)
		})

		it('counts a row once when it also matches the strict way through its text', async () => {
			// Title misspelled, but the body holds the word, so the strict pass counted it.
			await seedObjects('task', 'todo', 1, () => 'Mgnus')
			await db
				.update(objects)
				.set({ content: 'notes about magnus' })
				.where(eq(objects.title, 'Mgnus'))

			const res = await search({ q: 'magnus' })

			expect(res.results.map((r) => r.title)).toEqual(['Mgnus'])
			expect(res.total).toBe(1)
			expect(res.facets.types.task).toBe(1)
		})

		it('keeps hits out of the list when a filter hides them but still counts them', async () => {
			await seedObjects('task', 'todo', 1, () => 'Quarterly roadmap')
			await seedObjects('bet', 'active', 1, () => 'Quarterly goals')

			const res = await search({ q: 'qaurterly', types: ['bet'] })

			expect(res.results.map((r) => r.title)).toEqual(['Quarterly goals'])
			expect(res.total).toBe(1)
			expect(res.facets.types).toMatchObject({ task: 1, bet: 1 })
		})

		it('hides archived hits unless the archived group is selected', async () => {
			await seedObjects('task', 'archived', 1, () => 'Quarterly roadmap')

			expect((await search({ q: 'qaurterly' })).total).toBe(0)
			expect((await search({ q: 'qaurterly', statuses: ['archived'] })).total).toBe(1)
		})

		it('reads only titles and names, not text in the body', async () => {
			await seedObjects('task', 'todo', 1, () => 'Unrelated')
			await db
				.update(objects)
				.set({ content: 'notes about quarterly planning' })
				.where(eq(objects.title, 'Unrelated'))

			expect((await search({ q: 'qaurterly' })).total).toBe(0)
		})

		it('keeps the strict answer and lists the source as partial when it holds more than the cap', async () => {
			await seedObjects('task', 'todo', 5001, (i) => `filler ${i}`)
			await seedObjects('task', 'todo', 1, () => 'Quarterly roadmap')

			const res = await search({ q: 'qaurterly' })

			expect(res.partial).toEqual(['objects'])
		}, 60_000)

		it('still finds typos in the other sources when one source breaks', async () => {
			await seedObjects('task', 'todo', 1, () => 'Quarterly roadmap')
			await seedChat('Quarterly sync', [actorId])
			const sources = SEARCH_SOURCES.map((source) => ({
				...source,
				candidates: (ctx: Parameters<typeof source.candidates>[0]) =>
					source.key === 'automations'
						? sql`SELECT * FROM table_that_does_not_exist`
						: source.candidates(ctx),
			}))

			const res = await runSearch(
				db,
				{ workspaceId, callerId: actorId },
				query({ q: 'qaurterly' }),
				sources,
			)

			expect(res.partial).toEqual(['automations'])
			expect(res.results.map((r) => r.title).sort()).toEqual([
				'Quarterly roadmap',
				'Quarterly sync',
			])
		})
	})

	describe('over HTTP with the real auth middleware', () => {
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

		const auth = (ws: string, key = TEST_API_KEY) => ({
			Authorization: `Bearer ${key}`,
			'X-Workspace-Id': ws,
		})

		it('returns the full response shape for a member', async () => {
			await seedObjects('bet', 'active', 1, () => 'upsilon bet')
			const res = await createApp().request(jsonGet('/api/search?q=upsilon', auth(workspaceId)))
			expect(res.status).toBe(200)
			const body = (await res.json()) as SearchResponse
			expect(body).toMatchObject({
				total: 1,
				capped: false,
				partial: [],
				relaxed: { withoutFilters: 1, withoutStatuses: 1 },
			})
			expect(body.results[0]).toMatchObject({
				group: 'objects',
				type: 'bet',
				title: 'upsilon bet',
				status: 'active',
				statusGroup: 'in_progress',
			})
			expect(body.results[0]?.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
		})

		it('returns 404 for a workspace the caller is not in', async () => {
			const stranger = await insertActor(db, { name: 'Stranger' })
			const res = await createApp().request(
				jsonGet('/api/search?q=anything', auth(workspaceId, stranger.apiKey)),
			)
			expect(res.status).toBe(404)
		})

		it('returns 401 without a key', async () => {
			const res = await createApp().request(
				jsonGet('/api/search?q=anything', { 'X-Workspace-Id': workspaceId }),
			)
			expect(res.status).toBe(401)
		})

		it('returns 400 for an invalid status group', async () => {
			const res = await createApp().request(
				jsonGet('/api/search?statuses=bogus', auth(workspaceId)),
			)
			expect(res.status).toBe(400)
		})
	})
})
