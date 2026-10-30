import { conversationPendingTurns, messages } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { matchThread } from '../../services/session-manager'
import { insertActor, insertConversation, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

/**
 * Migrations 0119 and 0120: sessions and conversation_pending_turns get a nullable
 * thread_root_id, and sessions gets a second partial unique index on
 * (conversation, agent, COALESCE(thread, 0)) next to the old (conversation, agent) one.
 *
 * Each test file runs on its own database, so the old index can be dropped in beforeAll to
 * see the new one on its own, the state after the release that drops it. Mocked-DB tests
 * cannot prove unique-index semantics (.claude/rules/verification.md).
 */

const OLD_INDEX = 'sessions_conversation_actor_active_uniq'
const NEW_INDEX = 'sessions_conversation_actor_thread_active_uniq'

/** The unique-violation constraint name an insert fails with, or null when it succeeds. */
async function violatedConstraint(insert: Promise<unknown>): Promise<string | null> {
	try {
		await insert
		return null
	} catch (err) {
		for (let cur: unknown = err; cur && typeof cur === 'object'; ) {
			const e = cur as { code?: string; constraint_name?: string; cause?: unknown }
			if (e.code === '23505' && e.constraint_name) return e.constraint_name
			cur = e.cause
		}
		throw err
	}
}

describe('thread_root_id on sessions and conversation_pending_turns', () => {
	let workspaceId: string
	let ownerId: string

	// The shared setup truncates workspaces before every test, so each test makes its own.
	beforeEach(async () => {
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
	})

	async function chat() {
		const agent = await insertActor(db, { type: 'agent' })
		const conversation = await insertConversation(db, workspaceId, ownerId)
		return { agent, conversationId: conversation.id }
	}

	const live = (conversationId: string, threadRootId: number | null, status = 'running') => ({
		conversationId,
		interactive: true,
		status,
		threadRootId,
	})

	it('adds a nullable bigint thread_root_id to both tables', async () => {
		const cols = await sql<{ table_name: string; data_type: string; is_nullable: string }[]>`
			SELECT table_name, data_type, is_nullable FROM information_schema.columns
			WHERE table_schema = 'public' AND column_name = 'thread_root_id'
			  AND table_name IN ('sessions', 'conversation_pending_turns', 'messages')
			ORDER BY table_name
		`
		const byTable = Object.fromEntries(cols.map((c) => [c.table_name, c]))
		for (const table of ['sessions', 'conversation_pending_turns']) {
			expect(byTable[table]?.data_type).toBe(byTable.messages?.data_type)
			expect(byTable[table]?.data_type).toBe('bigint')
			expect(byTable[table]?.is_nullable).toBe('YES')
		}
	})

	it("creates the new index with the old index's predicate and keeps the old index", async () => {
		const rows = await sql<{ indexname: string; indexdef: string }[]>`
			SELECT indexname, indexdef FROM pg_indexes
			WHERE schemaname = 'public' AND tablename = 'sessions' AND indexname IN (${OLD_INDEX}, ${NEW_INDEX})
		`
		const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]))
		expect(Object.keys(byName).sort()).toEqual([NEW_INDEX, OLD_INDEX].sort())
		const def = byName[NEW_INDEX] as string
		expect(def).toMatch(/CREATE UNIQUE INDEX/)
		expect(def).toMatch(/conversation_id, actor_id, COALESCE\(thread_root_id,/i)
		// Postgres rewrites IN (...) to = ANY (ARRAY[...]) in indexdef; compare the predicate
		// of both indexes rather than the text of one shape.
		const predicate = (d: string) => d.slice(d.indexOf(' WHERE '))
		expect(predicate(def)).toBe(predicate(byName[OLD_INDEX] as string))
		expect(predicate(def)).toMatch(/interactive/)
	})

	describe('with the old index dropped (after the release that drops it)', () => {
		beforeAll(async () => {
			await sql.unsafe(`DROP INDEX IF EXISTS "${OLD_INDEX}"`)
		})

		it('rejects two live main-chat sessions for the same agent in one chat', async () => {
			const { agent, conversationId } = await chat()
			await insertSession(db, workspaceId, agent.id, ownerId, live(conversationId, null))
			const second = insertSession(
				db,
				workspaceId,
				agent.id,
				ownerId,
				live(conversationId, null, 'starting'),
			)
			expect(await violatedConstraint(second)).toBe(NEW_INDEX)
		})

		it('allows a main-chat session next to thread sessions, and one per thread', async () => {
			const { agent, conversationId } = await chat()
			await insertSession(db, workspaceId, agent.id, ownerId, live(conversationId, null))
			expect(
				await violatedConstraint(
					insertSession(db, workspaceId, agent.id, ownerId, live(conversationId, 101)),
				),
			).toBeNull()
			expect(
				await violatedConstraint(
					insertSession(db, workspaceId, agent.id, ownerId, live(conversationId, 102)),
				),
			).toBeNull()
			expect(
				await violatedConstraint(
					insertSession(db, workspaceId, agent.id, ownerId, live(conversationId, 101, 'pending')),
				),
			).toBe(NEW_INDEX)
		})

		it('lets a second session start once the first has ended, and keeps other agents and chats apart', async () => {
			const { agent, conversationId } = await chat()
			await insertSession(
				db,
				workspaceId,
				agent.id,
				ownerId,
				live(conversationId, 201, 'completed'),
			)
			expect(
				await violatedConstraint(
					insertSession(db, workspaceId, agent.id, ownerId, live(conversationId, 201)),
				),
			).toBeNull()

			const other = await insertActor(db, { type: 'agent' })
			expect(
				await violatedConstraint(
					insertSession(db, workspaceId, other.id, ownerId, live(conversationId, 201)),
				),
			).toBeNull()
			const { conversationId: otherChat } = await chat()
			expect(
				await violatedConstraint(
					insertSession(db, workspaceId, agent.id, ownerId, live(otherChat, 201)),
				),
			).toBeNull()
		})
	})

	it('matchThread scopes buffered turns to one thread, and null to the main chat', async () => {
		const { agent, conversationId } = await chat()
		const message = async () => {
			const [row] = await db
				.insert(messages)
				.values({ conversationId, actorId: ownerId, content: 'hi' })
				.returning()
			if (!row) throw new Error('failed to insert message')
			return row.id
		}
		const turn = async (threadRootId: number | null) =>
			db.insert(conversationPendingTurns).values({
				conversationId,
				actorId: agent.id,
				messageId: await message(),
				threadRootId,
				payload: {},
			})
		await turn(null)
		await turn(301)
		await turn(302)

		const remaining = async () =>
			(
				await db
					.select({ threadRootId: conversationPendingTurns.threadRootId })
					.from(conversationPendingTurns)
					.where(eq(conversationPendingTurns.conversationId, conversationId))
			)
				.map((r) => r.threadRootId)
				.sort()

		await db
			.delete(conversationPendingTurns)
			.where(matchThread(conversationPendingTurns.threadRootId, null))
		expect(await remaining()).toEqual([301, 302])
		await db
			.delete(conversationPendingTurns)
			.where(matchThread(conversationPendingTurns.threadRootId, 301))
		expect(await remaining()).toEqual([302])
	})
})
