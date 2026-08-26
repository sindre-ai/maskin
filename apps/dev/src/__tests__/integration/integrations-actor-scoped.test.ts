import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { integrations } from '@maskin/db/schema'
import { describe, expect, it } from 'vitest'
import { actorScopedProviders, getIntegrationCredential } from '../../lib/integrations/lookup'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')

async function runSqlFile(relativePath: string) {
	const content = readFileSync(join(migrationsDir, relativePath), 'utf-8')
	for (const statement of splitStatements(content)) {
		await sql.unsafe(statement)
	}
}

async function getIndexNames(): Promise<string[]> {
	const rows = await sql<{ indexname: string }[]>`
		SELECT indexname
		FROM pg_indexes
		WHERE schemaname = 'public'
		  AND tablename = 'integrations'
	`
	return rows.map((r) => r.indexname).sort()
}

describe('integrations actor-scoped schema (0065)', () => {
	it('adds a nullable actor_id column referencing actors(id)', async () => {
		const rows = await sql<{ column_name: string; is_nullable: string; data_type: string }[]>`
			SELECT column_name, is_nullable, data_type
			FROM information_schema.columns
			WHERE table_schema = 'public'
			  AND table_name = 'integrations'
			  AND column_name = 'actor_id'
		`
		expect(rows).toHaveLength(1)
		expect(rows[0].is_nullable).toBe('YES')
		expect(rows[0].data_type).toBe('uuid')

		const fk = await sql<{ foreign_table_name: string; foreign_column_name: string }[]>`
			SELECT ccu.table_name AS foreign_table_name,
			       ccu.column_name AS foreign_column_name
			FROM information_schema.table_constraints AS tc
			JOIN information_schema.key_column_usage AS kcu
			  ON tc.constraint_name = kcu.constraint_name
			JOIN information_schema.constraint_column_usage AS ccu
			  ON ccu.constraint_name = tc.constraint_name
			WHERE tc.constraint_type = 'FOREIGN KEY'
			  AND tc.table_name = 'integrations'
			  AND kcu.column_name = 'actor_id'
		`
		expect(fk).toHaveLength(1)
		expect(fk[0].foreign_table_name).toBe('actors')
		expect(fk[0].foreign_column_name).toBe('id')
	})

	it('replaces the workspace-scoped unique indexes with actor-inclusive ones', async () => {
		const names = await getIndexNames()
		expect(names).toContain('integrations_ws_actor_provider_external_uniq')
		expect(names).toContain('integrations_ws_actor_provider_null_external_uniq')
		expect(names).not.toContain('integrations_ws_provider_external_uniq')
		expect(names).not.toContain('integrations_ws_provider_null_external_uniq')
	})

	it('has a non-unique (workspace_id, provider) helper index', async () => {
		const names = await getIndexNames()
		expect(names).toContain('integrations_ws_provider_idx')

		const row = await sql<{ indexdef: string }[]>`
			SELECT indexdef FROM pg_indexes
			WHERE indexname = 'integrations_ws_provider_idx'
		`
		expect(row[0].indexdef).not.toMatch(/UNIQUE/i)
		expect(row[0].indexdef).toMatch(/workspace_id/)
		expect(row[0].indexdef).toMatch(/provider/)
	})

	it('leaves every existing row with actor_id = NULL (no backfill ran)', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		// Insert a workspace-scoped row exactly the way pre-0065 code would have —
		// no actorId override. It must land with actor_id = NULL.
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: 'test-legacy-provider',
				status: 'connected',
				credentials: 'x',
				createdBy: actorId,
			})
			.returning()
		expect(row.actorId).toBeNull()

		const [count] = await sql<{ count: string }[]>`
			SELECT COUNT(*)::text AS count FROM integrations WHERE actor_id IS NOT NULL
		`
		expect(count.count).toBe('0')
	})
})

describe('getIntegrationCredential — two actors, same workspace', () => {
	it('returns exactly the row for the requested actor when the provider is actor-scoped', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const actorA = await insertActor(db)
		const actorB = await insertActor(db)

		await db.insert(integrations).values([
			{
				workspaceId: ws.id,
				provider: 'linkedin-unipile',
				status: 'connected',
				credentials: 'creds-A',
				actorId: actorA.id,
				createdBy,
			},
			{
				workspaceId: ws.id,
				provider: 'linkedin-unipile',
				status: 'connected',
				credentials: 'creds-B',
				actorId: actorB.id,
				createdBy,
			},
		])

		const rowA = await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actorA.id)
		const rowB = await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actorB.id)

		expect(rowA?.credentials).toBe('creds-A')
		expect(rowB?.credentials).toBe('creds-B')
	})

	it('skips actor-scoped rows for unscoped providers', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const actor = await insertActor(db)

		// An actor-scoped row for a NON-scoped provider must not be returned
		// when the caller asks for that provider — the allow-list is the gate.
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: 'slack',
			status: 'connected',
			credentials: 'actor-scoped-slack',
			actorId: actor.id,
			createdBy,
		})

		const result = await getIntegrationCredential(db, ws.id, 'slack', actor.id)
		expect(result).toBeNull()
	})

	it('filters on status = connected', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const actor = await insertActor(db)

		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: 'linkedin-unipile',
			status: 'pending',
			credentials: 'not-yet',
			actorId: actor.id,
			createdBy,
		})

		const result = await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actor.id)
		expect(result).toBeNull()
	})
})

describe('allow-list is the single source of truth', () => {
	it('exposes exactly linkedin-unipile as actor-scoped', () => {
		expect([...actorScopedProviders].sort()).toEqual(['linkedin-unipile'])
	})
})

describe('0065 down migration is reversible', () => {
	// The reversibility contract: after up → down → up, the table has the
	// same shape as after the first up. We run the down migration by hand
	// against the DB (it lives under `drizzle/down/` so the runner never
	// executes it), then re-run the forward migration and re-check
	// everything the up-migration test above verified.
	it('round-trips: down restores the pre-0065 index shape, up restores the new one', async () => {
		// Sanity: we're currently AT 0065 (verified by earlier tests).
		let names = await getIndexNames()
		expect(names).toContain('integrations_ws_actor_provider_external_uniq')

		// Roll back.
		await runSqlFile('down/0065_integrations_actor_id_down.sql')

		names = await getIndexNames()
		expect(names).toContain('integrations_ws_provider_external_uniq')
		expect(names).toContain('integrations_ws_provider_null_external_uniq')
		expect(names).not.toContain('integrations_ws_actor_provider_external_uniq')
		expect(names).not.toContain('integrations_ws_actor_provider_null_external_uniq')
		expect(names).not.toContain('integrations_ws_provider_idx')

		const dropped = await sql<{ column_name: string }[]>`
			SELECT column_name FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'integrations' AND column_name = 'actor_id'
		`
		expect(dropped).toHaveLength(0)

		// Re-apply the forward migration and confirm we're back at the 0065 shape.
		await runSqlFile('0065_integrations_actor_id.sql')

		names = await getIndexNames()
		expect(names).toContain('integrations_ws_actor_provider_external_uniq')
		expect(names).toContain('integrations_ws_actor_provider_null_external_uniq')
		expect(names).toContain('integrations_ws_provider_idx')

		const restored = await sql<{ column_name: string }[]>`
			SELECT column_name FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'integrations' AND column_name = 'actor_id'
		`
		expect(restored).toHaveLength(1)
	})
})

describe('unique index enforces (workspace, actor, provider)', () => {
	it('rejects a duplicate (workspace_id, actor_id, provider) with the same NULL external_id', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const actor = await insertActor(db)

		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: 'linkedin-unipile',
			status: 'connected',
			credentials: 'creds-1',
			actorId: actor.id,
			createdBy,
		})

		await expect(
			db.insert(integrations).values({
				workspaceId: ws.id,
				provider: 'linkedin-unipile',
				status: 'connected',
				credentials: 'creds-2',
				actorId: actor.id,
				createdBy,
			}),
		).rejects.toThrow()
	})

	it('allows the same provider across two different actors in one workspace', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const actorA = await insertActor(db)
		const actorB = await insertActor(db)

		await expect(
			db.insert(integrations).values([
				{
					workspaceId: ws.id,
					provider: 'linkedin-unipile',
					status: 'connected',
					credentials: 'creds-A',
					actorId: actorA.id,
					createdBy,
				},
				{
					workspaceId: ws.id,
					provider: 'linkedin-unipile',
					status: 'connected',
					credentials: 'creds-B',
					actorId: actorB.id,
					createdBy,
				},
			]),
		).resolves.toBeDefined()
	})
})

