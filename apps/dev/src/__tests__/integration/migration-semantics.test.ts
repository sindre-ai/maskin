import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getTestActorId, sql } from './global-setup'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')

// These tests assert DB-level semantics that the application relies on but that
// mocked unit tests cannot verify. Each maps directly to a known-pitfall entry.
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

	it('0041 backfill sets awaiting_deploy=true on bet/task rows, preserves live_started_at', async () => {
		// Regression for AC-T5 on the ‘Live’ ≠ ‘deployed’ bet: the migration
		// must (a) add awaiting_deploy=true to every existing bet/task row that
		// does not yet carry the key, and (b) leave live_started_at (and every
		// other metadata key) untouched. Applied at boot in global-setup; the
		// assertion below re-applies the backfill against freshly seeded
		// pre-migration-shape rows to prove the SQL still behaves that way.
		const actorId = getTestActorId()
		const [workspace] = await sql`
			INSERT INTO workspaces (name, settings, created_by)
			VALUES ('backfill-test-ws', '{}', ${actorId})
			RETURNING id
		`
		await sql`
			INSERT INTO workspace_members (workspace_id, actor_id, role)
			VALUES (${workspace.id}, ${actorId}, 'owner')
		`

		// Three shapes of pre-migration bet/task row:
		//   1. bet with live_started_at set, no awaiting_deploy key.
		//   2. task with metadata NULL.
		//   3. bet already carrying awaiting_deploy=false — must NOT be overwritten.
		const [betWithLiveStart] = await sql`
			INSERT INTO objects (workspace_id, type, status, metadata, created_by)
			VALUES (
				${workspace.id},
				'bet',
				'live',
				${sql.json({ live_started_at: '2026-06-10', posthog_query: 'q1' })},
				${actorId}
			)
			RETURNING id
		`
		const [taskNullMetadata] = await sql`
			INSERT INTO objects (workspace_id, type, status, metadata, created_by)
			VALUES (${workspace.id}, 'task', 'in_progress', NULL, ${actorId})
			RETURNING id
		`
		const [betExplicitFalse] = await sql`
			INSERT INTO objects (workspace_id, type, status, metadata, created_by)
			VALUES (
				${workspace.id},
				'bet',
				'active',
				${sql.json({ awaiting_deploy: false })},
				${actorId}
			)
			RETURNING id
		`

		// Re-run the actual migration file. Idempotent by design.
		const migrationSql = readFileSync(
			join(migrationsDir, '0041_deployed_at_awaiting_deploy.sql'),
			'utf-8',
		)
		await sql.unsafe(migrationSql)

		const [row1] = await sql`SELECT metadata FROM objects WHERE id = ${betWithLiveStart.id}`
		expect(row1.metadata.awaiting_deploy, 'awaiting_deploy backfilled to true').toBe(true)
		expect(row1.metadata.live_started_at, 'live_started_at preserved').toBe('2026-06-10')
		expect(row1.metadata.posthog_query, 'other keys preserved').toBe('q1')
		expect(row1.metadata.deployed_at, 'deployed_at left absent').toBeUndefined()

		const [row2] = await sql`SELECT metadata FROM objects WHERE id = ${taskNullMetadata.id}`
		expect(row2.metadata.awaiting_deploy, 'NULL metadata upgraded to object with key').toBe(true)

		const [row3] = await sql`SELECT metadata FROM objects WHERE id = ${betExplicitFalse.id}`
		expect(row3.metadata.awaiting_deploy, 'pre-set false is not overwritten').toBe(false)

		// Fleet-wide invariant: no bet/task row is left without the key.
		const [{ count }] = await sql`
			SELECT COUNT(*)::int AS count
			FROM objects
			WHERE type IN ('bet', 'task')
				AND (metadata IS NULL OR NOT metadata ? 'awaiting_deploy')
		`
		expect(count, 'zero bet/task rows without awaiting_deploy').toBe(0)
	})
})
