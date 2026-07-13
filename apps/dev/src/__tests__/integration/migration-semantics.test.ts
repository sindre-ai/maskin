import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { describe, expect, it } from 'vitest'
import { getTestActorId, sql } from './global-setup'

// These tests assert DB-level semantics that the application relies on but that
// mocked unit tests cannot verify. Each maps directly to a known-pitfall entry.

async function replayMigration(filename: string): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url))
	const migrationsDir = join(here, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')
	const content = readFileSync(join(migrationsDir, filename), 'utf-8')
	for (const statement of splitStatements(content)) {
		await sql.unsafe(statement)
	}
}

async function getIndexColumns(relname: string): Promise<string[]> {
	const rows = await sql<{ column: string; ord: number }[]>`
		SELECT a.attname AS column, k.n AS ord
		FROM pg_index i
		JOIN pg_class c ON c.oid = i.indexrelid
		JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, n) ON TRUE
		JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
		WHERE c.relname = ${relname}
		ORDER BY k.n
	`
	return rows.map((r) => r.column)
}

describe('Migration semantics — pg_constraint / pg_trigger assertions', () => {
	it('relationships enforces UNIQUE(source_id, target_id, type)', async () => {
		// Regression for the unique-constraint class of bugs: if the constraint were
		// absent, duplicate relationship inserts would silently succeed and the
		// application's idempotency guarantees would be broken.
		const actorId = getTestActorId()
		const srcId = '11111111-1111-1111-1111-111111111111'
		const tgtId = '22222222-2222-2222-2222-222222222222'

		await sql`
			INSERT INTO relationships (source_type, source_id, target_type, target_id, type, created_by)
			VALUES ('object', ${srcId}, 'object', ${tgtId}, 'blocks', ${actorId})
		`

		await expect(
			sql`
				INSERT INTO relationships (source_type, source_id, target_type, target_id, type, created_by)
				VALUES ('object', ${srcId}, 'object', ${tgtId}, 'blocks', ${actorId})
			`,
		).rejects.toThrow(/unique/i)
	})

	it('sessions.trigger_id FK is ON DELETE SET NULL', async () => {
		// Regression: without SET NULL, DELETE /api/triggers/:id 500s with a FK
		// violation for any trigger that has ever fired. Migration 0021 fixed this.
		const [row] = await sql`
			SELECT c.confdeltype
			FROM pg_constraint c
			WHERE c.conrelid = 'public.sessions'::regclass
				AND c.contype = 'f'
				AND c.conkey = ARRAY[
					(SELECT attnum FROM pg_attribute
					 WHERE attrelid = 'public.sessions'::regclass AND attname = 'trigger_id')
				]::int2[]
		`
		// 'n' = SET NULL; 'a' = NO ACTION; 'r' = RESTRICT; 'c' = CASCADE
		expect(row?.confdeltype, 'sessions.trigger_id FK must be ON DELETE SET NULL').toBe('n')
	})

	it('notifications.session_id FK is ON DELETE SET NULL', async () => {
		// Regression: without SET NULL, deleting a session (e.g. cascading from an
		// actor delete) 500s with a FK violation for any notification that still
		// references it. Migration 0041 fixed this.
		const [row] = await sql`
			SELECT c.confdeltype
			FROM pg_constraint c
			WHERE c.conrelid = 'public.notifications'::regclass
				AND c.contype = 'f'
				AND c.conkey = ARRAY[
					(SELECT attnum FROM pg_attribute
					 WHERE attrelid = 'public.notifications'::regclass AND attname = 'session_id')
				]::int2[]
		`
		// 'n' = SET NULL; 'a' = NO ACTION; 'r' = RESTRICT; 'c' = CASCADE
		expect(row?.confdeltype, 'notifications.session_id FK must be ON DELETE SET NULL').toBe('n')
	})

	it('agent_files.session_id FK is ON DELETE SET NULL', async () => {
		// Regression: without SET NULL, deleting a session (e.g. cascading from an
		// actor delete) 500s with a FK violation for any agent_files row that still
		// references it — routinely true for any agent that has completed a session
		// and pushed learnings/skills back to storage. Migration 0042 fixed this.
		const [row] = await sql`
			SELECT c.confdeltype
			FROM pg_constraint c
			WHERE c.conrelid = 'public.agent_files'::regclass
				AND c.contype = 'f'
				AND c.conkey = ARRAY[
					(SELECT attnum FROM pg_attribute
					 WHERE attrelid = 'public.agent_files'::regclass AND attname = 'session_id')
				]::int2[]
		`
		// 'n' = SET NULL; 'a' = NO ACTION; 'r' = RESTRICT; 'c' = CASCADE
		expect(row?.confdeltype, 'agent_files.session_id FK must be ON DELETE SET NULL').toBe('n')
	})

	it('notify_event() trigger body does not include the data column', async () => {
		// Regression for the 8KB NOTIFY payload limit (migration 0006). If `data`
		// is re-added to the NOTIFY payload, large event rows will silently roll back.
		const [row] = await sql`
			SELECT prosrc FROM pg_proc WHERE proname = 'notify_event'
		`
		expect(row?.prosrc, 'notify_event function not found').toBeTruthy()
		// Confirm the payload does not reference the data column
		expect(row.prosrc, "notify_event must not include 'data' in pg_notify payload").not.toMatch(
			/'data'|"data"|NEW\.data/,
		)
	})

	it('objects has composite (workspace_id, updated_at) index objects_ws_updated_at_idx', async () => {
		// AC-T8: migrations 0043 must build the (workspace_id, updated_at) composite
		// index on objects. Without it, list_objects(updated_before=…) falls back to
		// a sequential scan once a workspace grows past a few thousand rows.
		expect(await getIndexColumns('objects_ws_updated_at_idx')).toEqual([
			'workspace_id',
			'updated_at',
		])
	})

	it('sessions has composite (workspace_id, updated_at) index sessions_ws_updated_at_idx', async () => {
		// AC-T8: same as objects, on sessions (migration 0044).
		expect(await getIndexColumns('sessions_ws_updated_at_idx')).toEqual([
			'workspace_id',
			'updated_at',
		])
	})

	it('DROP INDEX CONCURRENTLY IF EXISTS succeeds for both updated_at indexes', async () => {
		// AC-T8 rollback half: the operational down-migration is `DROP INDEX
		// CONCURRENTLY IF EXISTS` (per MIGRATIONS.md Rule 1). Verify it runs in
		// autocommit (postgres.unsafe()) and the indexes really go away, then
		// re-create them so sibling tests keep the schema they expect.
		//
		// Recreate happens in `finally` so a failed drop or assertion doesn't
		// leave these indexes permanently missing for the rest of the suite.
		try {
			await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "objects_ws_updated_at_idx"')
			await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "sessions_ws_updated_at_idx"')

			const gone = await sql<{ relname: string }[]>`
				SELECT relname FROM pg_class
				WHERE relname IN ('objects_ws_updated_at_idx', 'sessions_ws_updated_at_idx')
			`
			expect(gone).toEqual([])
		} finally {
			// Idempotent IF NOT EXISTS keeps this safe even if test ordering changes
			// or the drop above only partially succeeded.
			await sql.unsafe(
				'CREATE INDEX CONCURRENTLY IF NOT EXISTS "objects_ws_updated_at_idx" ON "objects" ("workspace_id", "updated_at")',
			)
			await sql.unsafe(
				'CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_ws_updated_at_idx" ON "sessions" ("workspace_id", "updated_at")',
			)
		}
	})

	it('inserting an event with >8KB content succeeds (notify payload truncation does not roll back)', async () => {
		// Regression: when notify_event() included NEW.data, pg_notify raised
		// "payload string too long" on large inserts, rolling back the row. With
		// `data` removed from the payload the INSERT must succeed regardless of size.
		const actorId = getTestActorId()
		const [workspace] = await sql`
			INSERT INTO workspaces (name, settings, created_by)
			VALUES ('notify-test-ws', '{}', ${actorId})
			RETURNING id
		`
		await sql`
			INSERT INTO workspace_members (workspace_id, actor_id, role)
			VALUES (${workspace.id}, ${actorId}, 'owner')
		`

		const largeData = { content: 'x'.repeat(9_000) } // > 8 KB when JSON-serialised

		const [event] = await sql`
			INSERT INTO events (workspace_id, actor_id, action, entity_type, entity_id, data)
			VALUES (
				${workspace.id},
				${actorId},
				'test.large_payload',
				'object',
				gen_random_uuid(),
				${JSON.stringify(largeData)}::jsonb
			)
			RETURNING id
		`
		expect(event?.id, 'Event INSERT must succeed despite large data payload').toBeTruthy()
	})

	// ── slack_user_links (migration 0040) ─────────────────────────────────────
	// Covers AC-T4: additive migration leaves existing Slack integrations rows
	// untouched and the rollback drops cleanly.

	it('slack_user_links exists, is empty after migration, and integrations rows are unchanged', async () => {
		const actorId = getTestActorId()
		const [ws] = await sql`
			INSERT INTO workspaces (name, created_by) VALUES ('slack-link-test', ${actorId})
			RETURNING id
		`
		await sql`
			INSERT INTO workspace_members (workspace_id, actor_id, role)
			VALUES (${ws.id}, ${actorId}, 'owner')
		`
		const [integration] = await sql`
			INSERT INTO integrations
				(workspace_id, provider, status, external_id, credentials, config, created_by)
			VALUES (${ws.id}, 'slack', 'active', 'T123', 'enc:placeholder', '{}'::jsonb, ${actorId})
			RETURNING id, workspace_id, provider, status, external_id, credentials, config, metadata, created_by, created_at, updated_at
		`

		const links = await sql`SELECT * FROM slack_user_links`
		expect(links.length, 'slack_user_links must be empty post-migration').toBe(0)

		const [after] = await sql`
			SELECT id, workspace_id, provider, status, external_id, credentials, config, metadata, created_by, created_at, updated_at
			FROM integrations WHERE id = ${integration.id}
		`
		expect(after, 'pre-existing integrations row must be byte-for-byte unchanged').toEqual(
			integration,
		)
	})

	it('slack_user_links FKs are ON DELETE CASCADE', async () => {
		const rows = await sql`
			SELECT
				(SELECT attname FROM pg_attribute
				 WHERE attrelid = c.conrelid AND attnum = c.conkey[1]) AS column_name,
				c.confdeltype
			FROM pg_constraint c
			WHERE c.conrelid = 'public.slack_user_links'::regclass
				AND c.contype = 'f'
		`
		const byColumn = Object.fromEntries(rows.map((r) => [r.column_name, r.confdeltype]))
		// 'c' = CASCADE
		expect(byColumn.actor_id, 'actor_id FK must be ON DELETE CASCADE').toBe('c')
		expect(byColumn.default_workspace_id, 'default_workspace_id FK must be ON DELETE CASCADE').toBe(
			'c',
		)
	})

	// ── bet archived status + archive_reason (migration 0047) ────────────────
	// T2 of `bet/archived-status`: the migration must add `archived` to every
	// workspace's settings.statuses.bet and register the archive_reason field on
	// bet — including on rows whose settings blob is missing intermediate keys —
	// and it must be idempotent when re-run against an already-patched row.

	it('0047 patches statuses.bet + field_definitions.bet on a pre-existing workspace', async () => {
		const actorId = getTestActorId()
		// Simulate a row that predates the migration: statuses.bet has the old
		// eight-status list; field_definitions.bet is absent.
		const [ws] = await sql`
			INSERT INTO workspaces (name, settings, created_by)
			VALUES (
				'archived-status-legacy',
				${JSON.stringify({
					statuses: {
						bet: [
							'signal',
							'qualified',
							'define',
							'active',
							'live',
							'succeeded',
							'failed',
							'paused',
						],
					},
				})}::jsonb,
				${actorId}
			)
			RETURNING id
		`
		// Re-run the 0047 migration statements against the seeded legacy row.
		await replayMigration('0047_bet_archived_status_and_archive_reason.sql')

		const [after] = await sql<{ settings: Record<string, unknown> }[]>`
			SELECT settings FROM workspaces WHERE id = ${ws.id}
		`
		const settings = after.settings as {
			statuses: { bet: string[] }
			field_definitions: { bet: Array<{ name: string; type: string; required: boolean }> }
		}
		expect(settings.statuses.bet, 'archived must be appended to statuses.bet').toContain('archived')
		expect(
			settings.statuses.bet.filter((s) => s === 'archived').length,
			'archived must appear exactly once',
		).toBe(1)
		expect(settings.field_definitions.bet, 'archive_reason must be registered on bet').toEqual([
			{ name: 'archive_reason', type: 'text', required: false },
		])
	})

	it('0047 handles a workspace whose settings has no statuses or field_definitions keys', async () => {
		const actorId = getTestActorId()
		const [ws] = await sql`
			INSERT INTO workspaces (name, settings, created_by)
			VALUES ('archived-status-bare', '{}'::jsonb, ${actorId})
			RETURNING id
		`
		await replayMigration('0047_bet_archived_status_and_archive_reason.sql')

		const [after] = await sql<{ settings: Record<string, unknown> }[]>`
			SELECT settings FROM workspaces WHERE id = ${ws.id}
		`
		const settings = after.settings as {
			statuses: { bet: string[] }
			field_definitions: { bet: Array<{ name: string }> }
		}
		expect(settings.statuses.bet).toEqual(['archived'])
		expect(settings.field_definitions.bet).toEqual([
			{ name: 'archive_reason', type: 'text', required: false },
		])
	})

	it('0047 is idempotent: a second run adds no duplicate entries', async () => {
		const actorId = getTestActorId()
		const [ws] = await sql`
			INSERT INTO workspaces (name, settings, created_by)
			VALUES (
				'archived-status-idempotent',
				${JSON.stringify({
					statuses: {
						bet: [
							'signal',
							'qualified',
							'define',
							'active',
							'live',
							'succeeded',
							'failed',
							'paused',
							'archived',
						],
					},
					field_definitions: {
						bet: [{ name: 'archive_reason', type: 'text', required: false }],
					},
				})}::jsonb,
				${actorId}
			)
			RETURNING id, settings
		`
		const before = ws.settings
		await replayMigration('0047_bet_archived_status_and_archive_reason.sql')
		await replayMigration('0047_bet_archived_status_and_archive_reason.sql')

		const [after] = await sql<{ settings: Record<string, unknown> }[]>`
			SELECT settings FROM workspaces WHERE id = ${ws.id}
		`
		expect(after.settings, 'settings must be unchanged when both patches already applied').toEqual(
			before,
		)
	})

	it('slack_user_links rollback drops the table and leaves integrations rows untouched', async () => {
		const actorId = getTestActorId()
		const [ws] = await sql`
			INSERT INTO workspaces (name, created_by) VALUES ('slack-rollback-test', ${actorId})
			RETURNING id
		`
		await sql`
			INSERT INTO workspace_members (workspace_id, actor_id, role)
			VALUES (${ws.id}, ${actorId}, 'owner')
		`
		const [integration] = await sql`
			INSERT INTO integrations
				(workspace_id, provider, status, external_id, credentials, config, created_by)
			VALUES (${ws.id}, 'slack', 'active', 'T456', 'enc:placeholder', '{}'::jsonb, ${actorId})
			RETURNING id
		`

		// DDL is transactional in Postgres — run the rollback inside a tx that we
		// abort, so the table is restored for subsequent tests in this suite.
		await sql
			.begin(async (tx) => {
				await tx`DROP TABLE slack_user_links`

				const [dropped] = await tx`SELECT to_regclass('public.slack_user_links') AS r`
				expect(dropped.r, 'slack_user_links must be gone after rollback').toBeNull()

				const stillThere = await tx`SELECT id FROM integrations WHERE id = ${integration.id}`
				expect(stillThere.length, 'integrations row must survive the rollback').toBe(1)

				throw new Error('__abort__')
			})
			.catch((err) => {
				if ((err as Error).message !== '__abort__') throw err
			})

		const [restored] = await sql`SELECT to_regclass('public.slack_user_links') AS r`
		expect(restored.r, 'tx abort must restore the schema for later tests').not.toBeNull()
	})
})
