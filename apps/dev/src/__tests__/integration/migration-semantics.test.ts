import { describe, expect, it } from 'vitest'
import { getTestActorId, sql } from './global-setup'

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

	it('import_audit_rows.import_id FK is ON DELETE CASCADE and action CHECK rejects unknown values', async () => {
		// Regression for AC-T5 (audit table migration / rollback story): the
		// audit table must follow the parent import's lifetime (no orphan
		// audit rows), and the action column must reject unknown values so
		// the writer can't silently drift the four-outcome contract.
		const actorId = getTestActorId()
		const [workspace] = await sql`
			INSERT INTO workspaces (name, settings, created_by)
			VALUES ('import-audit-test-ws', '{}', ${actorId})
			RETURNING id
		`
		await sql`
			INSERT INTO workspace_members (workspace_id, actor_id, role)
			VALUES (${workspace.id}, ${actorId}, 'owner')
		`
		const [importRow] = await sql`
			INSERT INTO imports (workspace_id, status, file_name, file_type, file_storage_key, created_by)
			VALUES (${workspace.id}, 'completed', 'test.csv', 'csv', 'storage/test.csv', ${actorId})
			RETURNING id
		`

		// Happy path — insert one audit row per allowed action.
		for (const action of ['created', 'updated', 'skipped', 'failed']) {
			await sql`
				INSERT INTO import_audit_rows (import_id, row_index, action)
				VALUES (${importRow.id}, 0, ${action})
			`
		}

		// CHECK constraint rejects unknown action values.
		await expect(
			sql`
				INSERT INTO import_audit_rows (import_id, row_index, action)
				VALUES (${importRow.id}, 1, 'merged')
			`,
		).rejects.toThrow(/check|constraint/i)

		// ON DELETE CASCADE: deleting the parent import wipes its audit rows
		// (no orphans, per the down-migration's "drop cleanly" requirement).
		await sql`DELETE FROM imports WHERE id = ${importRow.id}`
		const [{ count }] = await sql`
			SELECT COUNT(*)::int AS count FROM import_audit_rows WHERE import_id = ${importRow.id}
		`
		expect(count, 'audit rows must cascade-delete with the parent import').toBe(0)

		// Confirm the FK is declared as CASCADE at the catalog level so the
		// invariant is enforced by the schema, not just by this insert pattern.
		const [fk] = await sql`
			SELECT c.confdeltype
			FROM pg_constraint c
			WHERE c.conrelid = 'public.import_audit_rows'::regclass
				AND c.contype = 'f'
				AND c.conkey = ARRAY[
					(SELECT attnum FROM pg_attribute
					 WHERE attrelid = 'public.import_audit_rows'::regclass AND attname = 'import_id')
				]::int2[]
		`
		expect(fk?.confdeltype, 'import_audit_rows.import_id FK must be ON DELETE CASCADE').toBe('c')
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
})
