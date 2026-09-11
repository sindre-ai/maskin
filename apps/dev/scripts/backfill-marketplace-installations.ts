// One-shot backfill: surface seed-provisioned Marketplace items as "installed"
// in workspaces created before the seed-reify migration landed.
//
// New workspaces post-migration get an install-audit row (source='seed')
// written alongside every seeded loop/agent/skill row at bootstrap time.
// This script handles the pre-migration workspaces — walk existing
// installedLoops / actors / workspaceSkills rows, match their slug against
// the Marketplace catalog, and write install-audit rows for the matches.
// Unmatched rows (user-hand-created, not from a catalog seed) stay unlinked
// — that's correct: they weren't installed through the Marketplace, so they
// should not appear on the Manage state.
//
// Idempotent by design: guarded by the partial unique index
//   UNIQUE (workspace_id, item_kind, catalog_slug) WHERE uninstalled_at IS NULL
// on marketplace_installations (tech spec §2.2). Every insert uses ON
// CONFLICT DO NOTHING against that index, so re-running against the same DB
// is a no-op — the ops runbook (docs/runbooks/marketplace-backfill.md)
// documents running this after every deploy to catch new pre-migration
// workspaces that trickle in from restored backups.
//
// Ordering: this script depends on PR #1's schema (marketplace_installations
// table + link columns) being present. It talks to Postgres via raw SQL so
// it does NOT need PR #1's Drizzle schema exports — the tables just need to
// exist at runtime, which is what PR #1's migrations provide.
//
// Run manually:
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/backfill-marketplace-installations.ts
//
// Dry-run (report matches without writing):
//   DATABASE_URL=... DRY_RUN=1 pnpm --filter @maskin/dev exec tsx scripts/backfill-marketplace-installations.ts

import { pathToFileURL } from 'node:url'
import { createDb } from '@maskin/db'
import { sql } from 'drizzle-orm'

interface BackfillCounts {
	loops: { matched: number; inserted: number }
	agents: { matched: number; inserted: number }
	skills: { matched: number; inserted: number }
}

interface CountRow {
	inserted: number
}

async function backfillLoops(
	db: ReturnType<typeof createDb>,
	dryRun: boolean,
): Promise<BackfillCounts['loops']> {
	// installedLoops joins marketplaceLoops directly (sourceLoopId FK), so
	// the slug lookup is a straight PK read — no fuzzy slug matching needed.
	// Filter by absence of an existing live install-audit row.
	const matched = await db.execute<{ count: number }>(sql`
		SELECT COUNT(*)::int AS count
		FROM installed_loops il
		JOIN marketplace_loops ml ON ml.id = il.source_loop_id
		WHERE il.marketplace_installation_id IS NULL
		  AND NOT EXISTS (
		    SELECT 1
		    FROM marketplace_installations mi
		    WHERE mi.workspace_id = il.workspace_id
		      AND mi.item_kind = 'loop'
		      AND mi.catalog_slug = ml.slug
		      AND mi.uninstalled_at IS NULL
		  )
	`)
	const matchedCount = matched.rows[0]?.count ?? 0
	if (dryRun) return { matched: matchedCount, inserted: 0 }

	// Two-step: insert the install-audit rows for the matches, then update
	// the installedLoops row's FK to point at the freshly-inserted audit
	// row. The partial unique index makes the insert idempotent — a second
	// run finds no matches and no-ops. The joins run per-workspace so we
	// pick up the correct installedByActorId (workspace creator).
	const inserted = await db.execute<CountRow>(sql`
		WITH new_rows AS (
			INSERT INTO marketplace_installations (
				workspace_id, item_kind, catalog_id, catalog_slug,
				installed_loop_id, source, installed_by_actor_id, installed_at
			)
			SELECT
				il.workspace_id,
				'loop',
				ml.id,
				ml.slug,
				il.id,
				'seed',
				w.created_by,
				il.installed_at
			FROM installed_loops il
			JOIN marketplace_loops ml ON ml.id = il.source_loop_id
			JOIN workspaces w ON w.id = il.workspace_id
			WHERE il.marketplace_installation_id IS NULL
			ON CONFLICT (workspace_id, item_kind, catalog_slug)
				WHERE uninstalled_at IS NULL
				DO NOTHING
			RETURNING id, installed_loop_id
		),
		linked AS (
			UPDATE installed_loops il
			SET marketplace_installation_id = new_rows.id
			FROM new_rows
			WHERE il.id = new_rows.installed_loop_id
			RETURNING il.id
		)
		SELECT COUNT(*)::int AS inserted FROM linked
	`)
	return { matched: matchedCount, inserted: inserted.rows[0]?.inserted ?? 0 }
}

async function backfillAgents(
	db: ReturnType<typeof createDb>,
	dryRun: boolean,
): Promise<BackfillCounts['agents']> {
	// Agents don't have a direct FK to the marketplace catalog (actors.slug
	// isn't a schema field today — actors carry `name`, not a slug). Use
	// actors.name matched against marketplace_agents.slug's canonical form
	// (lowercased-with-hyphens) as the audit trail signal: seed-provisioned
	// agents carry their catalog display name verbatim, so a canonical-form
	// match on the marketplace catalog side lands the seed installs
	// without touching user-renamed actors.
	//
	// This is deliberately conservative: an agent the user renamed after
	// install won't match, and stays unlinked — that's correct, because we
	// can't distinguish "renamed seed agent" from "hand-created agent that
	// happened to be named after a catalog item".
	const matched = await db.execute<{ count: number }>(sql`
		SELECT COUNT(*)::int AS count
		FROM actors a
		JOIN workspace_members wm ON wm.actor_id = a.id
		JOIN marketplace_agents ma ON ma.slug = lower(regexp_replace(a.name, '\s+', '-', 'g'))
		WHERE a.type = 'agent'
		  AND a.marketplace_installation_id IS NULL
		  AND NOT EXISTS (
		    SELECT 1
		    FROM marketplace_installations mi
		    WHERE mi.workspace_id = wm.workspace_id
		      AND mi.item_kind = 'agent'
		      AND mi.catalog_slug = ma.slug
		      AND mi.uninstalled_at IS NULL
		  )
	`)
	const matchedCount = matched.rows[0]?.count ?? 0
	if (dryRun) return { matched: matchedCount, inserted: 0 }

	const inserted = await db.execute<CountRow>(sql`
		WITH new_rows AS (
			INSERT INTO marketplace_installations (
				workspace_id, item_kind, catalog_id, catalog_slug,
				actor_id, source, installed_by_actor_id, installed_at
			)
			SELECT
				wm.workspace_id,
				'agent',
				ma.id,
				ma.slug,
				a.id,
				'seed',
				w.created_by,
				a.created_at
			FROM actors a
			JOIN workspace_members wm ON wm.actor_id = a.id
			JOIN marketplace_agents ma ON ma.slug = lower(regexp_replace(a.name, '\s+', '-', 'g'))
			JOIN workspaces w ON w.id = wm.workspace_id
			WHERE a.type = 'agent'
			  AND a.marketplace_installation_id IS NULL
			ON CONFLICT (workspace_id, item_kind, catalog_slug)
				WHERE uninstalled_at IS NULL
				DO NOTHING
			RETURNING id, actor_id
		),
		linked AS (
			UPDATE actors a
			SET marketplace_installation_id = new_rows.id
			FROM new_rows
			WHERE a.id = new_rows.actor_id
			RETURNING a.id
		)
		SELECT COUNT(*)::int AS inserted FROM linked
	`)
	return { matched: matchedCount, inserted: inserted.rows[0]?.inserted ?? 0 }
}

async function backfillSkills(
	db: ReturnType<typeof createDb>,
	dryRun: boolean,
): Promise<BackfillCounts['skills']> {
	// workspaceSkills.name is workspace-unique, so canonical-form matching
	// against marketplace_skills.slug is safe (no chance of two seed skills
	// colliding under the same slug within one workspace).
	const matched = await db.execute<{ count: number }>(sql`
		SELECT COUNT(*)::int AS count
		FROM workspace_skills ws
		JOIN marketplace_skills ms ON ms.slug = lower(regexp_replace(ws.name, '\s+', '-', 'g'))
		WHERE ws.marketplace_installation_id IS NULL
		  AND NOT EXISTS (
		    SELECT 1
		    FROM marketplace_installations mi
		    WHERE mi.workspace_id = ws.workspace_id
		      AND mi.item_kind = 'skill'
		      AND mi.catalog_slug = ms.slug
		      AND mi.uninstalled_at IS NULL
		  )
	`)
	const matchedCount = matched.rows[0]?.count ?? 0
	if (dryRun) return { matched: matchedCount, inserted: 0 }

	const inserted = await db.execute<CountRow>(sql`
		WITH new_rows AS (
			INSERT INTO marketplace_installations (
				workspace_id, item_kind, catalog_id, catalog_slug,
				workspace_skill_id, source, installed_by_actor_id, installed_at
			)
			SELECT
				ws.workspace_id,
				'skill',
				ms.id,
				ms.slug,
				ws.id,
				'seed',
				w.created_by,
				ws.created_at
			FROM workspace_skills ws
			JOIN marketplace_skills ms ON ms.slug = lower(regexp_replace(ws.name, '\s+', '-', 'g'))
			JOIN workspaces w ON w.id = ws.workspace_id
			WHERE ws.marketplace_installation_id IS NULL
			ON CONFLICT (workspace_id, item_kind, catalog_slug)
				WHERE uninstalled_at IS NULL
				DO NOTHING
			RETURNING id, workspace_skill_id
		),
		linked AS (
			UPDATE workspace_skills ws
			SET marketplace_installation_id = new_rows.id
			FROM new_rows
			WHERE ws.id = new_rows.workspace_skill_id
			RETURNING ws.id
		)
		SELECT COUNT(*)::int AS inserted FROM linked
	`)
	return { matched: matchedCount, inserted: inserted.rows[0]?.inserted ?? 0 }
}

async function main(): Promise<void> {
	const url = process.env.POSTGRES_URL || process.env.DATABASE_URL
	if (!url) {
		console.error('POSTGRES_URL or DATABASE_URL is required.')
		process.exit(1)
	}

	const dryRun = process.env.DRY_RUN === '1'
	if (dryRun) console.log('DRY_RUN=1 — reporting matches only, no writes.')

	const db = createDb(url)
	const loops = await backfillLoops(db, dryRun)
	const agents = await backfillAgents(db, dryRun)
	const skills = await backfillSkills(db, dryRun)

	console.log('Marketplace install-audit backfill:')
	console.log(`  loops:  ${loops.inserted} inserted / ${loops.matched} matched`)
	console.log(`  agents: ${agents.inserted} inserted / ${agents.matched} matched`)
	console.log(`  skills: ${skills.inserted} inserted / ${skills.matched} matched`)
	console.log(
		`  total:  ${loops.inserted + agents.inserted + skills.inserted} audit rows written`,
	)
	// Note: mcp_server backfill is deliberately out of scope — Registry owns
	// mcp_installations and its own backfill script (tech spec §3.4 references
	// the Keychain/Registry backfill precedent). Running Registry's backfill
	// before this one gets the Tools tab installs into position.
	process.exit(0)
}

// Guard against running when imported by tests. Argv[1] is undefined under
// vitest workers, and truthy under direct `tsx` execution.
const invokedDirectly =
	typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.stack || err.message : err)
		process.exit(1)
	})
}
