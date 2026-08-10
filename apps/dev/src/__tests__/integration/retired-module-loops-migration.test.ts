import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql as rawSql } from './global-setup'

// Migration 0053 deletes the retired '*-module-loop' marketplace rows the
// rename to '*-extension-loop' orphaned (seedMarketplaceLoops upserts by slug,
// so the originals survived and the marketplace listed both).
//
// The harness replays every migration against an empty schema before this file
// runs, so 0053 has already executed against nothing. To actually exercise the
// SQL, seed the pre-rename state here and re-run the migration's statements —
// it is written to be idempotent and keyed entirely off slug, so replaying it
// is exactly what a real deploy does to a dirty database.

const MIGRATION_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
	'..',
	'..',
	'packages',
	'db',
	'drizzle',
	'0053_drop_retired_module_loops.sql',
)

async function runMigration0053() {
	const content = readFileSync(MIGRATION_PATH, 'utf-8')
	for (const statement of splitStatements(content)) {
		await rawSql.unsafe(statement)
	}
}

/** Recreate what a workspace looked like after installing the old Work Module loop. */
async function seedRetiredInstall(workspaceId: string, actorId: string) {
	const [loop] = await rawSql`
		INSERT INTO marketplace_loops (name, slug, description, version, use_case)
		VALUES ('Work Module', 'work-module-loop', 'Adds the Work extension.', '1.0.0', 'Extensions')
		RETURNING id
	`
	if (!loop) throw new Error('marketplace_loops insert returned no row')
	const loopId = loop.id as string

	await rawSql`
		INSERT INTO marketplace_loop_items (loop_id, item_type, source_item_id, item_snapshot)
		VALUES (${loopId}, 'extension', ${randomUUID()}, ${rawSql.json({ extensionId: 'work', name: 'Work' })})
	`

	const [loopObject] = await rawSql`
		INSERT INTO objects (workspace_id, type, title, status, created_by, metadata)
		VALUES (
			${workspaceId}, 'loop', 'Work Module', 'running', ${actorId},
			${rawSql.json({ installed_from_marketplace_loop_id: loopId, trigger_ids: [] })}
		)
		RETURNING id
	`
	if (!loopObject) throw new Error('objects insert returned no row')
	const objectId = loopObject.id as string

	await rawSql`
		INSERT INTO installed_loops (workspace_id, source_loop_id, object_id, installed_version, is_locked)
		VALUES (${workspaceId}, ${loopId}, ${objectId}, '1.0.0', true)
	`
	await rawSql`
		INSERT INTO subscriptions (workspace_id, actor_id, entity_type, entity_id, source)
		VALUES (${workspaceId}, ${actorId}, 'object', ${objectId}, 'author')
	`

	return { loopId, objectId }
}

describe('migration 0053 — drop retired module loops', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		// `slug` is unique, so a test that fails mid-seed would otherwise turn
		// every later test in this file into a duplicate-key error that hides the
		// original failure. Start each one from a clean slate.
		await runMigration0053()
		// Only the workspace uses the Drizzle handle — everything the migration
		// touches is seeded and asserted through raw SQL, so its own statements
		// are what's under test.
		const ws = await insertWorkspace(db, actorId, { settings: { enabled_modules: ['work'] } })
		workspaceId = ws.id
	})

	it('removes the retired loop, its items, its install and its Loop object', async () => {
		const { loopId, objectId } = await seedRetiredInstall(workspaceId, actorId)

		await runMigration0053()

		const loops = await rawSql`SELECT id FROM marketplace_loops WHERE id = ${loopId}`
		expect(loops).toHaveLength(0)
		const items = await rawSql`SELECT id FROM marketplace_loop_items WHERE loop_id = ${loopId}`
		expect(items).toHaveLength(0)
		const installs = await rawSql`SELECT id FROM installed_loops WHERE source_loop_id = ${loopId}`
		expect(installs).toHaveLength(0)
		const objects = await rawSql`SELECT id FROM objects WHERE id = ${objectId}`
		expect(objects).toHaveLength(0)
		const subs = await rawSql`
			SELECT id FROM subscriptions WHERE entity_type = 'object' AND entity_id = ${objectId}
		`
		expect(subs).toHaveLength(0)
	})

	// The whole point of the uninstall policy: removing the loop must never hide
	// the objects the extension's types cover.
	it('leaves the extension enabled in workspace settings', async () => {
		await seedRetiredInstall(workspaceId, actorId)

		await runMigration0053()

		const [ws] = await rawSql`SELECT settings FROM workspaces WHERE id = ${workspaceId}`
		expect((ws?.settings as { enabled_modules: string[] }).enabled_modules).toEqual(['work'])
	})

	it('leaves the renamed extension loop alone', async () => {
		const [kept] = await rawSql`
			INSERT INTO marketplace_loops (name, slug, description, version, use_case)
			VALUES ('Work Extension', 'work-extension-loop', 'Adds the Work extension.', '1.0.0', 'Extensions')
			RETURNING id
		`
		if (!kept) throw new Error('marketplace_loops insert returned no row')
		await seedRetiredInstall(workspaceId, actorId)

		await runMigration0053()

		const rows = await rawSql`SELECT slug FROM marketplace_loops WHERE id = ${kept.id}`
		expect(rows).toHaveLength(1)
		expect(rows[0]?.slug).toBe('work-extension-loop')

		// `slug` is unique — leave the table as this test found it so a rerun in
		// the same schema doesn't collide.
		await rawSql`DELETE FROM marketplace_loops WHERE id = ${kept.id}`
	})

	it('is a no-op on a database with no retired loops', async () => {
		await expect(runMigration0053()).resolves.not.toThrow()
	})
})
