import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import { describe, expect, it } from 'vitest'
import { actorScopedProviders, getIntegrationCredential } from '../../lib/integrations/lookup'
import {
	LINKEDIN_IDENTITY_PROVIDER,
	getConnectedLinkedInIdentityCount,
} from '../../lib/linkedin-addon'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')

// Runs a migration file's statements inside one explicit transaction. The
// production runner (packages/db/src/migrate.ts) gets this for free: neither
// 0065 nor its down file contains a `--> statement-breakpoint`, so
// splitStatements yields a single string and postgres.js sends it as one
// simple query, which Postgres wraps implicitly. Here we make it explicit so
// a statement that fails mid-file (see the actor-scoped-rows test below)
// rolls back rather than leaving `integrations` with its old indexes dropped
// and its new ones not yet created — a state every later test in this file
// would then fail against, masking the real failure.
async function runSqlFile(relativePath: string) {
	const content = readFileSync(join(migrationsDir, relativePath), 'utf-8')
	await sql.begin(async (tx) => {
		for (const statement of splitStatements(content)) {
			await tx.unsafe(statement)
		}
	})
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
				status: 'active',
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
				status: 'active',
				credentials: 'creds-A',
				actorId: actorA.id,
				createdBy,
			},
			{
				workspaceId: ws.id,
				provider: 'linkedin-unipile',
				status: 'active',
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
			status: 'active',
			credentials: 'actor-scoped-slack',
			actorId: actor.id,
			createdBy,
		})

		const result = await getIntegrationCredential(db, ws.id, 'slack', actor.id)
		expect(result).toBeNull()
	})

	// The helper must speak the same status vocabulary as the write paths in
	// routes/integrations.ts, which only ever write 'active' / 'pending' /
	// 'awaiting_secret' / 'error' / 'revoked'. A helper filtering on a status
	// no writer produces matches nothing, silently — so assert both that the
	// non-live statuses are rejected AND that the one the routes actually
	// write is accepted.
	it.each(['pending', 'awaiting_secret', 'error', 'revoked'])(
		'does not return a credential with status = %s',
		async (status) => {
			const createdBy = getTestActorId()
			const ws = await insertWorkspace(db, createdBy)
			const actor = await insertActor(db)

			await db.insert(integrations).values({
				workspaceId: ws.id,
				provider: 'linkedin-unipile',
				status,
				credentials: 'not-live',
				actorId: actor.id,
				createdBy,
			})

			const result = await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actor.id)
			expect(result).toBeNull()
		},
	)

	it('returns the credential for the status the connect routes actually write', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const actor = await insertActor(db)

		// 'active' is the literal every write path in routes/integrations.ts
		// uses (see :301, :313, :829, :847, :1422, :1443, :1646). If this
		// helper ever drifts to a status no writer produces, this fails.
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: 'linkedin-unipile',
			status: 'active',
			credentials: 'live-creds',
			actorId: actor.id,
			createdBy,
		})

		const result = await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actor.id)
		expect(result?.credentials).toBe('live-creds')
	})
})

describe('allow-list is the single source of truth', () => {
	it('exposes exactly linkedin-unipile as actor-scoped', () => {
		expect([...actorScopedProviders].sort()).toEqual(['linkedin-unipile'])
	})
})

describe('0065 down migration is reversible', () => {
	// The reversibility contract: after up -> down -> up, the table has the
	// same shape as after the first up. We run the down migration by hand
	// against the DB (it lives under `drizzle/down/` so the runner never
	// executes it), then re-run the forward migration and re-check
	// everything the up-migration test above verified.
	//
	// Both halves mutate schema shared by every later test in this file, so
	// the re-up is in a `finally` — a failed assertion between down and up
	// must not strand the rest of the run against the pre-0065 shape.
	it('round-trips: down restores the pre-0065 index shape, up restores the new one', async () => {
		// The down migration re-creates a UNIQUE index on
		// (workspace_id, provider) WHERE external_id IS NULL, which the
		// actor-scoped rows left behind by earlier tests in this file violate
		// by construction. Rolling back is only possible once they are gone —
		// see the test below, which pins that as behaviour rather than
		// working around it silently here.
		await sql`DELETE FROM integrations WHERE actor_id IS NOT NULL`

		// Sanity: we're currently AT 0065 (verified by earlier tests).
		let names = await getIndexNames()
		expect(names).toContain('integrations_ws_actor_provider_external_uniq')

		try {
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
		} finally {
			// Unconditional: the remaining tests in this file need the 0065 shape.
			await runSqlFile('0065_integrations_actor_id.sql')
		}

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

	it('refuses to roll back while actor-scoped rows exist, leaving 0065 intact', async () => {
		// Rolling back is not unconditionally safe: the pre-0065 unique index
		// on (workspace_id, provider) cannot be re-created while two actors in
		// one workspace hold credentials for the same provider — which is
		// exactly the state 0065 exists to allow. An operator must decide what
		// happens to those rows first. Asserting it here keeps that
		// precondition from being discovered during an incident.
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const actorA = await insertActor(db)
		const actorB = await insertActor(db)

		await db.insert(integrations).values([
			{
				workspaceId: ws.id,
				provider: 'linkedin-unipile',
				status: 'active',
				credentials: 'creds-A',
				actorId: actorA.id,
				createdBy,
			},
			{
				workspaceId: ws.id,
				provider: 'linkedin-unipile',
				status: 'active',
				credentials: 'creds-B',
				actorId: actorB.id,
				createdBy,
			},
		])

		try {
			await expect(runSqlFile('down/0065_integrations_actor_id_down.sql')).rejects.toThrow(
				/could not create unique index|duplicate key/i,
			)

			// runSqlFile is transactional, so the failed down rolled back
			// whole — the 0065 shape must be untouched, not half-dropped.
			const names = await getIndexNames()
			expect(names).toContain('integrations_ws_actor_provider_external_uniq')
			expect(names).toContain('integrations_ws_actor_provider_null_external_uniq')
			expect(names).toContain('integrations_ws_provider_idx')
			expect(names).not.toContain('integrations_ws_provider_null_external_uniq')
		} finally {
			await sql`DELETE FROM integrations WHERE actor_id IS NOT NULL`
		}
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
			status: 'active',
			credentials: 'creds-1',
			actorId: actor.id,
			createdBy,
		})

		await expect(
			db.insert(integrations).values({
				workspaceId: ws.id,
				provider: 'linkedin-unipile',
				status: 'active',
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
					status: 'active',
					credentials: 'creds-A',
					actorId: actorA.id,
					createdBy,
				},
				{
					workspaceId: ws.id,
					provider: 'linkedin-unipile',
					status: 'active',
					credentials: 'creds-B',
					actorId: actorB.id,
					createdBy,
				},
			]),
		).resolves.toBeDefined()
	})
})

describe('getConnectedLinkedInIdentityCount — status vocabulary', () => {
	// Regression: the SKU count filtered `status = 'connected'` while the only
	// writer writes 'active', so the count was permanently 0 and the €29 add-on
	// line could never render for any workspace. Every test at the time mocked
	// the count away, so nothing caught it. This exercises the real predicate
	// against real rows.
	it('counts rows written with the status the connect callback actually writes', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const actorA = await insertActor(db)
		const actorB = await insertActor(db)

		await db.insert(integrations).values([
			{
				workspaceId: ws.id,
				provider: LINKEDIN_IDENTITY_PROVIDER,
				status: INTEGRATION_STATUS_ACTIVE,
				credentials: 'creds-A',
				actorId: actorA.id,
				createdBy,
			},
			{
				workspaceId: ws.id,
				provider: LINKEDIN_IDENTITY_PROVIDER,
				status: INTEGRATION_STATUS_ACTIVE,
				credentials: 'creds-B',
				actorId: actorB.id,
				createdBy,
			},
		])

		expect(await getConnectedLinkedInIdentityCount(db, ws.id)).toBe(2)
	})

	it('excludes pending and revoked rows, and rows from other workspaces', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const otherWs = await insertWorkspace(db, createdBy)
		const actorA = await insertActor(db)
		const actorB = await insertActor(db)
		const actorC = await insertActor(db)

		await db.insert(integrations).values([
			{
				workspaceId: ws.id,
				provider: LINKEDIN_IDENTITY_PROVIDER,
				status: INTEGRATION_STATUS_ACTIVE,
				credentials: 'live',
				actorId: actorA.id,
				createdBy,
			},
			{
				workspaceId: ws.id,
				provider: LINKEDIN_IDENTITY_PROVIDER,
				status: 'pending',
				credentials: '',
				actorId: actorB.id,
				createdBy,
			},
			{
				workspaceId: ws.id,
				provider: LINKEDIN_IDENTITY_PROVIDER,
				status: 'revoked',
				credentials: 'dead',
				actorId: actorC.id,
				createdBy,
			},
			{
				workspaceId: otherWs.id,
				provider: LINKEDIN_IDENTITY_PROVIDER,
				status: INTEGRATION_STATUS_ACTIVE,
				credentials: 'elsewhere',
				actorId: actorA.id,
				createdBy,
			},
		])

		expect(await getConnectedLinkedInIdentityCount(db, ws.id)).toBe(1)
	})
})
