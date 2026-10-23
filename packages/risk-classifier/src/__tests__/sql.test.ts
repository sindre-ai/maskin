import { describe, expect, it } from 'vitest'
import { analyzeSql } from '../lib/sql.js'

const CORE = [
	'actors',
	'objects',
	'events',
	'sessions',
	'files',
	'workspace_credit_ledger',
	'credential_access_log',
]

function analyze(sql: string, isDown = false) {
	return analyzeSql(sql, { coreTables: CORE, isDown })
}

const rules = (sql: string, isDown = false) => analyze(sql, isDown).map((f) => f.rule)

describe('analyzeSql: not gated', () => {
	it('lets a new feature table with its own indexes and constraints through', () => {
		const sql = `
			-- A new feature table.
			CREATE TABLE IF NOT EXISTS "voice_notes" (
				"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				"title" text NOT NULL,
				CONSTRAINT "voice_notes_title_len" CHECK (char_length("title") < 200)
			);
			--> statement-breakpoint
			CREATE INDEX IF NOT EXISTS "voice_notes_title_idx" ON "voice_notes" ("title");
			ALTER TABLE "voice_notes" ADD COLUMN "extra" text;
			COMMENT ON TABLE "voice_notes" IS 'DROP me, UPDATE events, GRANT all';
		`
		expect(analyze(sql)).toEqual([])
	})

	it('lets a foreign key from a new table to a core table through', () => {
		const sql = `
			CREATE TABLE "reminders" (
				"id" uuid PRIMARY KEY,
				"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
				"object_id" uuid REFERENCES public.objects(id) ON UPDATE CASCADE
			);
			CREATE INDEX "reminders_actor_idx" ON "reminders" ("actor_id");
			ALTER TABLE "reminders" ADD CONSTRAINT "reminders_fk" FOREIGN KEY ("object_id") REFERENCES "objects"("id");
		`
		expect(analyze(sql)).toEqual([])
	})

	it('lets a backfill on a feature table through', () => {
		expect(
			analyze(
				`UPDATE "voice_sessions" SET "turn_count" = 0; DELETE FROM device_tokens WHERE 1 = 0;`,
			),
		).toEqual([])
	})

	it('does not read a core name inside a longer name as the core table', () => {
		expect(
			analyze('ALTER TABLE voice_sessions ADD COLUMN x int; UPDATE agent_sessions_log SET a = 1;'),
		).toEqual([])
	})

	it('treats DROP NOT NULL and DROP DEFAULT as loosening, not dropping', () => {
		expect(
			analyze(
				'ALTER TABLE notes ALTER COLUMN a DROP NOT NULL; ALTER TABLE notes ALTER COLUMN b DROP DEFAULT;',
			),
		).toEqual([])
	})

	it('ignores a file with only comments', () => {
		expect(analyze('-- nothing here\n/* DROP TABLE objects; */')).toEqual([])
	})

	it('lets a rollback script drop what its migration added', () => {
		expect(
			analyze(
				'ALTER TABLE "voice_sessions" DROP COLUMN IF EXISTS "turn_count";\nDROP TABLE IF EXISTS "reminders";',
				true,
			),
		).toEqual([])
	})
})

describe('analyzeSql: core tables', () => {
	it.each([
		['ALTER TABLE "objects" ADD COLUMN "x" text;', 'objects'],
		['alter table if exists only public.actors add column x int', 'actors'],
		['UPDATE "events" SET "data" = data;', 'events'],
		['DELETE FROM sessions WHERE id = 1;', 'sessions'],
		['INSERT INTO "files" ("id") VALUES (1);', 'files'],
		[
			'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx ON "objects" USING btree (title);',
			'objects',
		],
		['CREATE TRIGGER t AFTER UPDATE ON events FOR EACH ROW EXECUTE FUNCTION f();', 'events'],
		['WITH gone AS (DELETE FROM files RETURNING id) SELECT count(*) FROM gone;', 'files'],
		[
			'CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$ BEGIN INSERT INTO workspace_credit_ledger VALUES (1); RETURN NEW; END $$ LANGUAGE plpgsql;',
			'workspace_credit_ledger',
		],
		['LOCK TABLE credential_access_log IN ACCESS EXCLUSIVE MODE;', 'credential_access_log'],
	])('gates %s', (sql, table) => {
		const found = analyze(sql)
		expect(found.some((f) => f.kind === 'core_table' && f.rule === table)).toBe(true)
	})

	it('gates a scrub inside a DO block', () => {
		const sql = `DO $$ BEGIN UPDATE events SET data = '{}' WHERE id < 10; END $$;`
		expect(analyze(sql).some((f) => f.kind === 'core_table' && f.rule === 'events')).toBe(true)
	})

	it('names the table and the action', () => {
		const [f] = analyze('ALTER TABLE objects ADD COLUMN x int;')
		expect(f?.detail).toContain('ALTER on core table objects')
	})

	it('still judges a rollback script that touches a core table', () => {
		expect(rules('ALTER TABLE objects DROP COLUMN x;', true)).toContain('objects')
		expect(rules('DROP TABLE objects;', true)).toContain('DROP')
	})
})

describe('analyzeSql: always gated', () => {
	it.each([
		['DROP TABLE IF EXISTS "voice_notes";', 'DROP'],
		['ALTER TABLE voice_notes DROP COLUMN title;', 'DROP'],
		['DROP INDEX voice_notes_idx;', 'DROP'],
		['TRUNCATE voice_notes;', 'TRUNCATE'],
		['GRANT SELECT ON voice_notes TO anon;', 'GRANT/REVOKE'],
		['REVOKE ALL ON voice_notes FROM anon;', 'GRANT/REVOKE'],
		['CREATE ROLE reader;', 'ROLE'],
		['ALTER ROLE reader SET search_path = public;', 'ROLE'],
		['SET ROLE postgres;', 'ROLE'],
		['ALTER TABLE voice_notes OWNER TO postgres;', 'ROLE'],
		['ALTER TABLE voice_notes ENABLE ROW LEVEL SECURITY;', 'ROW LEVEL SECURITY'],
		['CREATE POLICY p ON voice_notes USING (true);', 'POLICY'],
	])('gates %s', (sql, rule) => {
		expect(rules(sql)).toContain(rule)
	})

	it('gates row security switched on for every table through dynamic SQL', () => {
		const sql = `
			CREATE OR REPLACE PROCEDURE enable_rls_public_tables() LANGUAGE plpgsql AS $$
			DECLARE tbl text;
			BEGIN
				FOR tbl IN SELECT relname FROM pg_class LOOP
					EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
				END LOOP;
			END $$;
			--> statement-breakpoint
			CALL enable_rls_public_tables();
			DROP PROCEDURE enable_rls_public_tables();
		`
		const found = rules(sql)
		expect(found).toContain('ROW LEVEL SECURITY')
		expect(found).toContain('dynamic SQL')
		expect(found).toContain('DROP')
	})

	it('gates dynamic SQL in a DO block even when no core table is named', () => {
		expect(rules(`DO $$ BEGIN EXECUTE 'DELETE FROM ' || quote_ident('x'); END $$;`)).toContain(
			'dynamic SQL',
		)
	})

	it('does not read EXECUTE FUNCTION in a trigger definition as dynamic SQL', () => {
		const found = rules(
			'CREATE TRIGGER t BEFORE INSERT ON voice_notes FOR EACH ROW EXECUTE FUNCTION f();',
		)
		expect(found).toEqual([])
	})
})

describe('analyzeSql: unparseable', () => {
	it.each([
		["ALTER TABLE notes ADD COLUMN x text DEFAULT 'oops;"],
		['CREATE TABLE notes (id uuid;'],
		['CREATE TABLE notes (id uuid));'],
		['DO $$ BEGIN NULL; END'],
		['SELECT 1 /* never closed'],
		['ALTER TABLE "notes ADD COLUMN x text;'],
	])('gates %s', (sql) => {
		const found = analyze(sql)
		expect(found).toHaveLength(1)
		expect(found[0]?.kind).toBe('unparseable')
	})

	it('gates a statement it does not recognise', () => {
		const found = analyze("COPY objects FROM program 'curl evil';")
		expect(found[0]?.kind).toBe('unparseable')
	})

	it('keeps scanning past a semicolon inside a string or a dollar-quoted body', () => {
		expect(
			rules(
				`INSERT INTO notes VALUES ('a;b'); DO $$ BEGIN PERFORM 1; UPDATE events SET a = 1; END $$;`,
			),
		).toContain('events')
	})
})
