import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marketplaceAgents, marketplaceLoops, marketplaceSkills } from '@maskin/db/schema'
import { splitStatements } from '@maskin/db/migrate-utils'
import { asc, isNull } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db, sql } from './global-setup'

/**
 * Seed-reify idempotency — Marketplace tech spec §9.1.
 *
 * `0073_seed_marketplace_catalog.sql` is the v1 admin curation path
 * (spec §7). It reifies packages/shared/src/templates/marketplace-catalog.ts
 * into global (workspace_id IS NULL) rows on the three catalog tables.
 * The test contract: running the reify migration twice against the same
 * database MUST leave the catalog rowset unchanged (equal row counts,
 * equal per-row content), because the workspace-bootstrap and the
 * production migration pipeline both run it exactly once per DB but the
 * ON CONFLICT DO UPDATE path is what makes future authored-in-place edits
 * safe.
 *
 * global-setup.ts runs every migration in packages/db/drizzle/ once at
 * beforeAll — so the first reify run has already happened by the time this
 * test starts. We snapshot the resulting catalog, execute the same SQL
 * again via `sql.unsafe`, and assert the snapshot is byte-identical.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_REIFY_MIGRATION_PATH = join(
	__dirname,
	'..',
	'..',
	'..',
	'..',
	'..',
	'packages',
	'db',
	'drizzle',
	'0073_seed_marketplace_catalog.sql',
)

async function snapshotCatalog() {
	// Global-catalog rows only (workspace-private curation is out of scope
	// for the seed reify — the migration inserts NULL workspace_id).
	const [loops, agents, skills] = await Promise.all([
		db
			.select()
			.from(marketplaceLoops)
			.orderBy(asc(marketplaceLoops.slug)),
		db
			.select()
			.from(marketplaceAgents)
			.where(isNull(marketplaceAgents.workspaceId))
			.orderBy(asc(marketplaceAgents.slug)),
		db
			.select()
			.from(marketplaceSkills)
			.where(isNull(marketplaceSkills.workspaceId))
			.orderBy(asc(marketplaceSkills.slug)),
	])
	// updated_at drifts on each ON CONFLICT DO UPDATE run — strip it before
	// comparison so we assert curator-authored fields only. id is preserved
	// by the UPSERT, so it stays in the snapshot as a stability check.
	const strip = <T extends Record<string, unknown>>(rows: T[]) =>
		rows.map(({ updatedAt: _u, createdAt: _c, ...rest }) => rest)
	return {
		loops: strip(loops),
		agents: strip(agents),
		skills: strip(skills),
	}
}

describe('marketplace seed reify — idempotency', () => {
	it('running the seed migration a second time leaves the catalog rowset unchanged', async () => {
		const before = await snapshotCatalog()

		// Sanity — the initial migration already ran during global-setup, so
		// the three catalog tables must be non-empty on first read.
		expect(before.loops.length).toBeGreaterThan(0)
		expect(before.agents.length).toBeGreaterThan(0)
		expect(before.skills.length).toBeGreaterThan(0)

		// Re-execute the same migration SQL. `splitStatements` mirrors the
		// harness's migration runner exactly (§ packages/db/src/migrate-utils.ts)
		// so we exercise the same drizzle-kit `--> statement-breakpoint` shape
		// production applies.
		const migrationSql = readFileSync(SEED_REIFY_MIGRATION_PATH, 'utf-8')
		for (const statement of splitStatements(migrationSql)) {
			await sql.unsafe(statement)
		}

		const after = await snapshotCatalog()

		expect(after.loops.length).toBe(before.loops.length)
		expect(after.agents.length).toBe(before.agents.length)
		expect(after.skills.length).toBe(before.skills.length)
		expect(after.loops).toEqual(before.loops)
		expect(after.agents).toEqual(before.agents)
		expect(after.skills).toEqual(before.skills)
	})

	it('preserves install_count denormalized counters across re-runs', async () => {
		// The ON CONFLICT DO UPDATE clauses in 0073 deliberately omit
		// install_count from the SET list so counter state accumulated by
		// the marketplace-install service (§3.2) is not clobbered by a
		// re-authored migration. Simulate a counter bump on a global row,
		// re-run the reify, and assert the bump survived.
		const [loop] = await db.select().from(marketplaceLoops).limit(1)
		const bumped = (loop.installCount ?? 0) + 42
		await sql`UPDATE marketplace_loops SET install_count = ${bumped} WHERE id = ${loop.id}`

		const migrationSql = readFileSync(SEED_REIFY_MIGRATION_PATH, 'utf-8')
		for (const statement of splitStatements(migrationSql)) {
			await sql.unsafe(statement)
		}

		const [afterLoop] = await sql`
			SELECT install_count FROM marketplace_loops WHERE id = ${loop.id}
		`
		expect(Number(afterLoop.install_count)).toBe(bumped)
	})
})
