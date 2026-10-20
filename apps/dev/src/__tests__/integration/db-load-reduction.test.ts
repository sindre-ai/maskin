import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversations, objects, sessions, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { getWorkspacePlanUsdCentsUsage } from '../../lib/llm-routing'
import { insertActor, insertObject, insertSession, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId, sql } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

/**
 * Real-Postgres coverage for the changes that cut database load: the
 * `conversation_id` list filter and the three indexes (0083–0085) that back the
 * session-teardown update, the For You unread feed and the billing usage sum.
 *
 * Mocked-DB tests cannot show any of this: a filter that returns the right rows
 * through a seq scan, or an index whose predicate the real query never matches,
 * both look fine until production.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: Record<string, ReturnType<typeof vi.fn>>
	}
}

function createSessionsApp(actorId: string, appDb: Database = db) {
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
		c.set('sessionManager', {} as unknown as Env['Variables']['sessionManager'])
		await next()
	})
	app.route('/api/sessions', sessionsRoutes)
	return app
}

/**
 * EXPLAIN a statement with sequential scans disabled, so the plan shows which
 * indexes the planner *can* use for it. Disabling seq scans matters on a tiny
 * test table, where the planner would otherwise always prefer one.
 */
async function explainWithIndexes(query: string, params: unknown[]): Promise<string> {
	return sql.begin(async (tx) => {
		await tx.unsafe('SET LOCAL enable_seqscan = off')
		const rows = await tx.unsafe(`EXPLAIN (FORMAT JSON) ${query}`, params as never[])
		return JSON.stringify(rows)
	})
}

describe('db load reduction', () => {
	let workspaceId: string
	let humanId: string

	beforeEach(async () => {
		humanId = getTestActorId()
		const ws = await insertWorkspace(db, humanId)
		if (!ws) throw new Error('failed to seed workspace')
		workspaceId = ws.id
	})

	async function seedConversation() {
		const [conversation] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'Test chat', createdBy: humanId })
			.returning()
		if (!conversation) throw new Error('failed to seed conversation')
		return conversation
	}

	describe('GET /sessions?conversation_id=', () => {
		it("returns only the conversation's sessions, resolved from the indexed column", async () => {
			const agent = await insertActor(db, { type: 'agent' })
			if (!agent) throw new Error('failed to seed agent')
			await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })
			const mine = await seedConversation()
			const other = await seedConversation()

			const inMine = await insertSession(db, workspaceId, agent.id, humanId, {
				conversationId: mine.id,
				config: { conversation: { conversation_id: mine.id, message_id: 1 } },
			})
			await insertSession(db, workspaceId, agent.id, humanId, {
				conversationId: other.id,
				config: { conversation: { conversation_id: other.id, message_id: 1 } },
			})
			await insertSession(db, workspaceId, agent.id, humanId)

			const app = createSessionsApp(humanId)
			const res = await app.request(
				jsonGet(`/api/sessions?verbose=true&conversation_id=${mine.id}`, {
					'X-Workspace-Id': workspaceId,
				}),
			)

			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<{ id: string }>
			expect(body.map((s) => s.id)).toEqual([inMine?.id])
		})

		it('issues SQL the conversation index can serve, not a JSONB path scan', async () => {
			const conversation = await seedConversation()
			const captured: Array<{ query: string; params: unknown[] }> = []
			const loggedDb = drizzle(sql, {
				schema: { sessions },
				logger: { logQuery: (query, params) => captured.push({ query, params }) },
			}) as unknown as Database

			const app = createSessionsApp(humanId, loggedDb)
			const res = await app.request(
				jsonGet(`/api/sessions?verbose=true&conversation_id=${conversation.id}`, {
					'X-Workspace-Id': workspaceId,
				}),
			)
			expect(res.status).toBe(200)

			const issued = captured.find((c) => c.query.includes('from "sessions"'))
			if (!issued) throw new Error('sessions list query was not issued')
			expect(issued.query).not.toContain("'conversation'")
			const plan = await explainWithIndexes(issued.query, issued.params)

			expect(plan).toContain('sessions_conversation_actor_idx')
		})
	})

	describe('objects.active_session_id', () => {
		it('has a valid partial index the session-teardown update can use', async () => {
			const [index] = await sql`
				SELECT i.indisvalid AS valid, pg_get_expr(i.indpred, i.indrelid) AS predicate
				FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
				WHERE c.relname = 'objects_active_session_idx'`
			expect(index?.valid).toBe(true)
			expect(index?.predicate).toContain('active_session_id IS NOT NULL')

			const update = db
				.update(objects)
				.set({ activeSessionId: null, updatedAt: new Date() })
				.where(eq(objects.activeSessionId, '11111111-1111-4111-8111-111111111111'))
				.toSQL()
			const plan = await explainWithIndexes(update.sql, update.params)

			expect(plan).toContain('objects_active_session_idx')
		})

		it('still clears the pointer for the right object', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			if (!agent) throw new Error('failed to seed agent')
			const session = await insertSession(db, workspaceId, agent.id, humanId)
			const target = await insertObject(db, workspaceId, humanId, { activeSessionId: session?.id })
			const bystander = await insertObject(db, workspaceId, humanId)

			await db
				.update(objects)
				.set({ activeSessionId: null })
				.where(eq(objects.activeSessionId, session?.id as string))

			const [after] = await db
				.select()
				.from(objects)
				.where(eq(objects.id, target?.id as string))
			expect(after?.activeSessionId).toBeNull()
			const [untouched] = await db
				.select()
				.from(objects)
				.where(eq(objects.id, bystander?.id as string))
			expect(untouched?.activeSessionId).toBeNull()
		})
	})

	describe('events comments-only index', () => {
		it('exists as a valid partial index on commented events', async () => {
			const [index] = await sql`
				SELECT i.indisvalid AS valid, pg_get_expr(i.indpred, i.indrelid) AS predicate
				FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
				WHERE c.relname = 'events_ws_entity_commented_idx'`
			expect(index?.valid).toBe(true)
			expect(index?.predicate).toContain('commented')
		})
	})

	describe('getWorkspacePlanUsdCentsUsage', () => {
		async function seedPlanSession(
			route: string,
			costUsd: string,
			overrides: Record<string, unknown> = {},
		) {
			const agent = await insertActor(db, { type: 'agent' })
			if (!agent) throw new Error('failed to seed agent')
			return insertSession(db, workspaceId, agent.id, humanId, {
				config: { llm_route: route },
				totalCostUsd: costUsd,
				...overrides,
			})
		}

		it('sums only maskin_plan sessions inside the period', async () => {
			await seedPlanSession('maskin_plan', '0.10')
			await seedPlanSession('maskin_plan', '0.25')
			await seedPlanSession('claude_oauth', '5.00')
			await seedPlanSession('maskin_plan', '9.00', {
				createdAt: new Date(Date.now() - 90 * 86_400_000),
			})

			const cents = await getWorkspacePlanUsdCentsUsage(
				db,
				workspaceId,
				Date.now() - 30 * 86_400_000,
			)

			expect(cents).toBe(35)
		})

		it('issues SQL that the maskin_plan partial index can serve', async () => {
			const captured: Array<{ query: string; params: unknown[] }> = []
			const loggedDb = drizzle(sql, {
				schema: { sessions },
				logger: { logQuery: (query, params) => captured.push({ query, params }) },
			}) as unknown as Database
			await getWorkspacePlanUsdCentsUsage(loggedDb, workspaceId, Date.now() - 86_400_000)

			const issued = captured.find((c) => c.query.includes('"sessions"'))
			if (!issued) throw new Error('usage query was not issued')
			const plan = await explainWithIndexes(issued.query, issued.params)

			expect(plan).toContain('sessions_ws_plan_usage_idx')
		})
	})
})
