import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { conversations, relationships, sessions } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { recordEvent, writeSpawnedEdge } from '../../lib/events/record-event'
import { FLAGS, _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { resolveEndpointTitles } from '../../lib/graph/endpoint-titles'
import objectsRoutes from '../../routes/objects'
import relationshipsRoutes from '../../routes/relationships'
import { insertObject, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

// Full paths to the two migration halves — walked by the reversibility test
// below via psql on file contents, not through the migration runner (that
// only picks up `packages/db/drizzle/*.sql`, never the sibling `down/`
// carve-out).
const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATION_DIR = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')
const UP_SQL = join(MIGRATION_DIR, '0074_graph_conversation_session_types.sql')
const DOWN_SQL = join(MIGRATION_DIR, 'down', '0074_graph_conversation_session_types_down.sql')

// Env-driven flag priming: `resolveFlags` reads FF_TESTER_* on demand and
// caches the parse. Tests that need the flag ON set both and reset the cache;
// tests that need it OFF blank the vars and reset the cache. Never mutate
// process.env without a matching reset — a stale parse silently pins the
// flag state for the rest of the suite.
function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		process.env[key] = undefined
	} else {
		process.env[key] = value
	}
}

function withFlagOn(actorId: string, fn: () => Promise<void>): Promise<void> {
	const prevActors = process.env.FF_TESTER_ACTOR_IDS
	const prevFlags = process.env.FF_TESTER_FEATURES
	process.env.FF_TESTER_ACTOR_IDS = actorId
	process.env.FF_TESTER_FEATURES = FLAGS.GRAPH_PROVENANCE_WRITES
	_resetFeatureFlagConfig()
	return fn().finally(() => {
		setEnv('FF_TESTER_ACTOR_IDS', prevActors)
		setEnv('FF_TESTER_FEATURES', prevFlags)
		_resetFeatureFlagConfig()
	})
}

function withFlagOff(fn: () => Promise<void>): Promise<void> {
	const prevActors = process.env.FF_TESTER_ACTOR_IDS
	const prevFlags = process.env.FF_TESTER_FEATURES
	setEnv('FF_TESTER_ACTOR_IDS', undefined)
	setEnv('FF_TESTER_FEATURES', undefined)
	_resetFeatureFlagConfig()
	return fn().finally(() => {
		setEnv('FF_TESTER_ACTOR_IDS', prevActors)
		setEnv('FF_TESTER_FEATURES', prevFlags)
		_resetFeatureFlagConfig()
	})
}

async function insertSession(
	workspaceId: string,
	actorId: string,
	overrides: Partial<typeof sessions.$inferInsert> = {},
) {
	const [row] = await db
		.insert(sessions)
		.values({
			workspaceId,
			actorId,
			status: 'running',
			actionPrompt: 'Do the thing that produces the object',
			interactive: false,
			createdBy: actorId,
			...overrides,
		})
		.returning()
	if (!row) throw new Error('failed to insert session')
	return row
}

describe('S2 · graph provenance writer + read hydration', () => {
	describe('migration 0074', () => {
		afterAll(async () => {
			// Restore the migrated state for the rest of the suite: the reversibility
			// test below leaves the DB post-down, and every other integration test
			// in this file assumes the widened CHECK is in place.
			for (const stmt of splitStatements(readFileSync(UP_SQL, 'utf8'))) {
				await sql.unsafe(stmt)
			}
		})

		it('applies clean · widens CHECK to admit conversation + session and adds metadata column', async () => {
			// Force a re-apply: the up file is idempotent (DROP CONSTRAINT IF
			// EXISTS · ADD CONSTRAINT · VALIDATE · ADD COLUMN IF NOT EXISTS), so
			// running it on top of an already-migrated DB is a no-op that still
			// exercises every statement.
			for (const stmt of splitStatements(readFileSync(UP_SQL, 'utf8'))) {
				await sql.unsafe(stmt)
			}

			// CHECK admits the new endpoint kinds — a direct insert of a
			// conversation → session row succeeds, which the pre-0074 CHECK
			// (object|file only) would have rejected.
			const workspace = await insertWorkspace(db, getTestActorId())
			const [conversation] = await sql`
				INSERT INTO conversations (workspace_id, title, created_by)
				VALUES (${workspace.id}, 'test conversation', ${getTestActorId()})
				RETURNING id
			`
			const session = await insertSession(workspace.id, getTestActorId())
			await sql`
				INSERT INTO relationships (source_type, source_id, target_type, target_id, type, metadata, created_by)
				VALUES ('conversation', ${conversation.id}, 'session', ${session.id}, 'spawned', ${{ messageId: 42 }}, ${getTestActorId()})
			`

			// Metadata column round-trips its jsonb payload.
			const [row] = await db
				.select({ metadata: relationships.metadata })
				.from(relationships)
				.where(
					and(
						eq(relationships.sourceId, conversation.id),
						eq(relationships.targetId, session.id),
						eq(relationships.type, 'spawned'),
					),
				)
			expect((row?.metadata as { messageId?: number } | null)?.messageId).toBe(42)
		})

		it('rolls back clean · narrows CHECK, drops metadata, sweeps new-kind rows', async () => {
			// Seed a provenance row that the down migration must sweep before it
			// can narrow the CHECK. Without the DELETE the narrowed CHECK would
			// fail to validate an existing row and abort the migration.
			const workspace = await insertWorkspace(db, getTestActorId())
			const [conversation] = await sql`
				INSERT INTO conversations (workspace_id, title, created_by)
				VALUES (${workspace.id}, 'sweep me', ${getTestActorId()})
				RETURNING id
			`
			const session = await insertSession(workspace.id, getTestActorId())
			await sql`
				INSERT INTO relationships (source_type, source_id, target_type, target_id, type, created_by)
				VALUES ('conversation', ${conversation.id}, 'session', ${session.id}, 'spawned', ${getTestActorId()})
			`

			for (const stmt of splitStatements(readFileSync(DOWN_SQL, 'utf8'))) {
				await sql.unsafe(stmt)
			}

			// Metadata column is gone.
			const [meta] = await sql`
				SELECT column_name FROM information_schema.columns
				WHERE table_name = 'relationships' AND column_name = 'metadata'
			`
			expect(meta).toBeUndefined()

			// Narrowed CHECK rejects the same conversation → session insert now.
			const anotherSession = await insertSession(workspace.id, getTestActorId())
			await expect(
				sql`
					INSERT INTO relationships (source_type, source_id, target_type, target_id, type, created_by)
					VALUES ('conversation', ${conversation.id}, 'session', ${anotherSession.id}, 'spawned', ${getTestActorId()})
				`,
			).rejects.toThrow(/relationships_source_target_type_kind/)
		})
	})

	describe('produced_by writer hook', () => {
		let workspaceId: string
		let sessionActorId: string
		let session: typeof sessions.$inferSelect
		let objectId: string

		beforeEach(async () => {
			const workspace = await insertWorkspace(db, getTestActorId())
			workspaceId = workspace.id
			sessionActorId = getTestActorId()
			session = await insertSession(workspaceId, sessionActorId)
			const obj = await insertObject(db, workspaceId, sessionActorId)
			objectId = obj.id
		})

		it('writes a session → object produced_by edge when the flag is on and sessionId is present', async () => {
			await withFlagOn(sessionActorId, async () => {
				await recordEvent(db, {
					workspaceId,
					actorId: sessionActorId,
					action: 'updated',
					entityType: 'task',
					entityId: objectId,
					data: { changes: [] },
					provenance: { sessionId: session.id, entityKind: 'object' },
				})
			})

			const rows = await db
				.select()
				.from(relationships)
				.where(
					and(
						eq(relationships.sourceId, session.id),
						eq(relationships.targetId, objectId),
						eq(relationships.type, 'produced_by'),
					),
				)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.sourceType).toBe('session')
			expect(rows[0]?.targetType).toBe('object')
		})

		it('writes no edge when sessionId is absent (human write) — mutation still succeeds', async () => {
			await withFlagOn(sessionActorId, async () => {
				await recordEvent(db, {
					workspaceId,
					actorId: sessionActorId,
					action: 'updated',
					entityType: 'task',
					entityId: objectId,
					data: { changes: [] },
					// No `provenance` — mirrors a UI-authored PATCH.
				})
			})

			const rows = await db.select().from(relationships).where(eq(relationships.targetId, objectId))
			expect(rows).toHaveLength(0)
		})

		it('writes no edge when the flag is off — mutation still succeeds', async () => {
			await withFlagOff(async () => {
				await recordEvent(db, {
					workspaceId,
					actorId: sessionActorId,
					action: 'updated',
					entityType: 'task',
					entityId: objectId,
					data: { changes: [] },
					provenance: { sessionId: session.id, entityKind: 'object' },
				})
			})

			const rows = await db.select().from(relationships).where(eq(relationships.targetId, objectId))
			expect(rows).toHaveLength(0)
		})

		it('is idempotent · a repeat mutation on the same session/entity does not double-write', async () => {
			await withFlagOn(sessionActorId, async () => {
				for (let i = 0; i < 3; i++) {
					await recordEvent(db, {
						workspaceId,
						actorId: sessionActorId,
						action: 'updated',
						entityType: 'task',
						entityId: objectId,
						data: { changes: [{ i }] },
						provenance: { sessionId: session.id, entityKind: 'object' },
					})
				}
			})

			const rows = await db
				.select()
				.from(relationships)
				.where(
					and(
						eq(relationships.sourceId, session.id),
						eq(relationships.targetId, objectId),
						eq(relationships.type, 'produced_by'),
					),
				)
			expect(rows).toHaveLength(1)
		})
	})

	describe('spawned edge on session CREATE from a chat', () => {
		it('writes a conversation → session spawned edge with messageId persisted', async () => {
			const workspace = await insertWorkspace(db, getTestActorId())
			const [conversationRow] = await db
				.insert(conversations)
				.values({
					workspaceId: workspace.id,
					title: 'spawn source',
					createdBy: getTestActorId(),
				})
				.returning()
			if (!conversationRow) throw new Error('conversation insert returned no row')
			const conversationId = conversationRow.id
			const session = await insertSession(workspace.id, getTestActorId(), {
				conversationId: conversationId,
			})

			await withFlagOn(getTestActorId(), async () => {
				await writeSpawnedEdge(db, {
					workspaceId: workspace.id,
					conversationId: conversationId,
					sessionId: session.id,
					sessionActorId: getTestActorId(),
					messageId: 12345,
				})
			})

			const [edge] = await db
				.select()
				.from(relationships)
				.where(
					and(
						eq(relationships.sourceId, conversationId),
						eq(relationships.targetId, session.id),
						eq(relationships.type, 'spawned'),
					),
				)
			expect(edge).toBeDefined()
			expect(edge?.sourceType).toBe('conversation')
			expect(edge?.targetType).toBe('session')
			expect((edge?.metadata as { messageId?: number } | null)?.messageId).toBe(12345)
		})

		it('writes no edge when the flag is off', async () => {
			const workspace = await insertWorkspace(db, getTestActorId())
			const [conversationRow] = await db
				.insert(conversations)
				.values({
					workspaceId: workspace.id,
					title: 'no spawn',
					createdBy: getTestActorId(),
				})
				.returning()
			if (!conversationRow) throw new Error('conversation insert returned no row')
			const conversationId = conversationRow.id
			const session = await insertSession(workspace.id, getTestActorId(), {
				conversationId: conversationId,
			})

			await withFlagOff(async () => {
				await writeSpawnedEdge(db, {
					workspaceId: workspace.id,
					conversationId: conversationId,
					sessionId: session.id,
					sessionActorId: getTestActorId(),
					messageId: 9999,
				})
			})

			const rows = await db.select().from(relationships).where(eq(relationships.type, 'spawned'))
			expect(rows).toHaveLength(0)
		})

		it('resolveEndpointTitles hydrates conversation and session endpoint titles in one batch', async () => {
			const workspace = await insertWorkspace(db, getTestActorId())
			const [conversationRow] = await db
				.insert(conversations)
				.values({
					workspaceId: workspace.id,
					title: 'chat title',
					createdBy: getTestActorId(),
				})
				.returning()
			if (!conversationRow) throw new Error('conversation insert returned no row')
			const conversationId = conversationRow.id
			const session = await insertSession(workspace.id, getTestActorId(), {
				actionPrompt: 'Investigate the pipeline lag\nSecond line ignored',
			})

			const titles = await resolveEndpointTitles(db, {
				conversationIds: [conversationId],
				sessionIds: [session.id],
			})

			expect(titles.get(conversationId)).toBe('chat title')
			expect(titles.get(session.id)).toBe('Investigate the pipeline lag')
		})
	})

	describe('read hydration through the API', () => {
		it('GET /api/relationships returns hydrated conversation + session titles', async () => {
			const workspace = await insertWorkspace(db, getTestActorId())
			const [conversationRow] = await db
				.insert(conversations)
				.values({
					workspaceId: workspace.id,
					title: 'origin chat',
					createdBy: getTestActorId(),
				})
				.returning()
			if (!conversationRow) throw new Error('conversation insert returned no row')
			const conversationId = conversationRow.id
			const session = await insertSession(workspace.id, getTestActorId(), {
				conversationId: conversationId,
				actionPrompt: 'Draft the launch note',
			})
			await db.insert(relationships).values({
				sourceType: 'conversation',
				sourceId: conversationId,
				targetType: 'session',
				targetId: session.id,
				type: 'spawned',
				metadata: { messageId: 1 },
				createdBy: getTestActorId(),
			})

			const app = createIntegrationApp({ path: '/api/relationships', module: relationshipsRoutes })
			const res = await app.request(
				jsonGet(`/api/relationships?source_id=${conversationId}`, {
					'X-Workspace-Id': workspace.id,
				}),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<{
				sourceTitle: string | null
				targetTitle: string | null
				type: string
			}>
			expect(body).toHaveLength(1)
			expect(body[0]?.sourceTitle).toBe('origin chat')
			expect(body[0]?.targetTitle).toBe('Draft the launch note')
			expect(body[0]?.type).toBe('spawned')
		})

		it('GET /api/objects/:id/graph returns the produced_by edge and hydrates the ancestor spawned edge with messageId (T4 <Origin>)', async () => {
			const workspace = await insertWorkspace(db, getTestActorId())
			const startObj = await insertObject(db, workspace.id, getTestActorId(), {
				title: 'produced bet',
				type: 'bet',
			})
			const [conversationRow] = await db
				.insert(conversations)
				.values({
					workspaceId: workspace.id,
					title: 'origin chat',
					createdBy: getTestActorId(),
				})
				.returning()
			if (!conversationRow) throw new Error('conversation insert returned no row')
			const conversationId = conversationRow.id
			const session = await insertSession(workspace.id, getTestActorId(), {
				conversationId,
				actionPrompt: 'Draft the launch note',
			})
			// Wire: bet <-produced_by- session <-spawned- conversation (the spawn
			// edge does NOT touch startObj directly — the T4 change is that the
			// /graph endpoint follows produced_by one hop upstream so the Origin
			// block can render its Chat cell in one round-trip).
			await db.insert(relationships).values({
				sourceType: 'session',
				sourceId: session.id,
				targetType: 'object',
				targetId: startObj.id,
				type: 'produced_by',
				createdBy: getTestActorId(),
			})
			await db.insert(relationships).values({
				sourceType: 'conversation',
				sourceId: conversationId,
				targetType: 'session',
				targetId: session.id,
				type: 'spawned',
				metadata: { messageId: 4242 },
				createdBy: getTestActorId(),
			})

			const app = createIntegrationApp({ path: '/api/objects', module: objectsRoutes })
			const res = await app.request(
				jsonGet(`/api/objects/${startObj.id}/graph`, {
					'X-Workspace-Id': workspace.id,
				}),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				relationships: Array<{
					sourceType: string
					sourceId: string
					sourceTitle: string | null
					targetType: string
					targetId: string
					targetTitle: string | null
					type: string
					metadata: Record<string, unknown> | null
				}>
			}
			const producedBy = body.relationships.find((r) => r.type === 'produced_by')
			expect(producedBy).toBeDefined()
			expect(producedBy?.sourceType).toBe('session')
			expect(producedBy?.sourceTitle).toBe('Draft the launch note')

			// The spawn edge is the ancestor hop this task added — the Origin
			// block reads it to render Chat + the "Open chat at this moment"
			// deep-link via metadata.messageId.
			const spawned = body.relationships.find((r) => r.type === 'spawned')
			expect(spawned).toBeDefined()
			expect(spawned?.sourceType).toBe('conversation')
			expect(spawned?.sourceTitle).toBe('origin chat')
			expect(spawned?.targetType).toBe('session')
			expect(spawned?.metadata).toEqual({ messageId: 4242 })
		})

		it('GET /api/objects/:id/graph does not fetch upstream edges when there is no produced_by (absence contract)', async () => {
			const workspace = await insertWorkspace(db, getTestActorId())
			const startObj = await insertObject(db, workspace.id, getTestActorId(), {
				title: 'human-created bet',
				type: 'bet',
			})
			// No produced_by anywhere. The /graph endpoint must not surface a
			// spawn edge on another object as a lineage hop — the Origin block
			// stays absent (spec §Rabbit holes: absence = no session).
			const [conversationRow] = await db
				.insert(conversations)
				.values({
					workspaceId: workspace.id,
					title: 'unrelated chat',
					createdBy: getTestActorId(),
				})
				.returning()
			if (!conversationRow) throw new Error('conversation insert returned no row')
			const strangerSession = await insertSession(workspace.id, getTestActorId(), {
				conversationId: conversationRow.id,
				actionPrompt: 'Some other work',
			})
			await db.insert(relationships).values({
				sourceType: 'conversation',
				sourceId: conversationRow.id,
				targetType: 'session',
				targetId: strangerSession.id,
				type: 'spawned',
				metadata: { messageId: 99 },
				createdBy: getTestActorId(),
			})

			const app = createIntegrationApp({ path: '/api/objects', module: objectsRoutes })
			const res = await app.request(
				jsonGet(`/api/objects/${startObj.id}/graph`, {
					'X-Workspace-Id': workspace.id,
				}),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				relationships: Array<{ type: string }>
			}
			expect(body.relationships.some((r) => r.type === 'produced_by')).toBe(false)
			expect(body.relationships.some((r) => r.type === 'spawned')).toBe(false)
		})

		it('GET /api/objects/:id/graph/traverse walks conversation and session endpoints', async () => {
			const workspace = await insertWorkspace(db, getTestActorId())
			const startObj = await insertObject(db, workspace.id, getTestActorId(), {
				title: 'root bet',
				type: 'bet',
			})
			const [conversationRow] = await db
				.insert(conversations)
				.values({
					workspaceId: workspace.id,
					title: 'lineage chat',
					createdBy: getTestActorId(),
				})
				.returning()
			if (!conversationRow) throw new Error('conversation insert returned no row')
			const conversationId = conversationRow.id
			const session = await insertSession(workspace.id, getTestActorId(), {
				conversationId: conversationId,
				actionPrompt: 'Produce a bet under lineage chat',
			})
			// Wire: root bet <-produced_by- session <-spawned- conversation
			await db.insert(relationships).values({
				sourceType: 'session',
				sourceId: session.id,
				targetType: 'object',
				targetId: startObj.id,
				type: 'produced_by',
				createdBy: getTestActorId(),
			})
			await db.insert(relationships).values({
				sourceType: 'conversation',
				sourceId: conversationId,
				targetType: 'session',
				targetId: session.id,
				type: 'spawned',
				metadata: { messageId: 7 },
				createdBy: getTestActorId(),
			})

			const app = createIntegrationApp({ path: '/api/objects', module: objectsRoutes })
			const res = await app.request(
				jsonGet(`/api/objects/${startObj.id}/graph/traverse?max_depth=3&max_nodes=50`, {
					'X-Workspace-Id': workspace.id,
				}),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				nodes: Array<{ id: string; type: string; title: string | null }>
				edges: Array<{ source: string; target: string; type: string }>
			}
			const nodeTypes = new Set(body.nodes.map((n) => n.type))
			expect(nodeTypes).toContain('bet')
			expect(nodeTypes).toContain('session')
			expect(nodeTypes).toContain('conversation')
			const edgeTypes = new Set(body.edges.map((e) => e.type))
			expect(edgeTypes).toContain('produced_by')
			expect(edgeTypes).toContain('spawned')
		})
	})
})
