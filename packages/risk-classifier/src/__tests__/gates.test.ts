import { describe, expect, it } from 'vitest'
import { collectGates } from '../gates.js'
import type { DiffFile } from '../types.js'

const CORE = ['actors', 'objects', 'events']

function migration(path: string, sql: string, overrides: Partial<DiffFile> = {}): DiffFile {
	const lines = sql.split('\n')
	return {
		path,
		status: 'added',
		additions: lines.length,
		deletions: 0,
		patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`,
		...overrides,
	}
}

const gates = (files: DiffFile[]) => collectGates({ files, core_tables: CORE })

describe('collectGates', () => {
	it('does not gate a migration that only creates a feature table', () => {
		const sql =
			'CREATE TABLE "notes" ("id" uuid PRIMARY KEY, "actor_id" uuid REFERENCES "actors"("id"));'
		expect(gates([migration('packages/db/drizzle/0108_notes.sql', sql)])).toEqual([])
	})

	it('gates ALTER on a core table and says which file and table', () => {
		const [g] = gates([
			migration('packages/db/drizzle/0108_x.sql', 'ALTER TABLE "objects" ADD COLUMN "x" text;'),
		])
		expect(g?.kind).toBe('core_table_gate')
		expect(g?.evidence).toContain('packages/db/drizzle/0108_x.sql')
		expect(g?.evidence).toContain('core table objects')
	})

	it('gates a migration whose SQL cannot be read', () => {
		const [g] = gates([
			migration(
				'packages/db/drizzle/0108_x.sql',
				"ALTER TABLE notes ADD COLUMN x text DEFAULT 'oops;",
			),
		])
		expect(g?.kind).toBe('unparseable_sql')
	})

	it('gates a migration whose SQL is not in the diff', () => {
		const binary = migration('packages/db/drizzle/0108_x.sql', '', {
			additions: 0,
			patch: 'Binary files /dev/null and b/packages/db/drizzle/0108_x.sql differ',
		})
		expect(gates([binary])[0]?.kind).toBe('unparseable_sql')
		const empty = migration('packages/db/drizzle/0108_y.sql', '', { additions: 12, patch: '' })
		expect(gates([empty])[0]?.kind).toBe('unparseable_sql')
	})

	it('gates an edit to a migration that already exists', () => {
		const edited = migration('packages/db/drizzle/0050_old.sql', 'SELECT 1;', {
			status: 'modified',
		})
		const [g] = gates([edited])
		expect(g?.kind).toBe('unparseable_sql')
		expect(g?.evidence).toContain('existing migration modified')
	})

	it('reads a rollback script as a rollback', () => {
		const down = migration(
			'packages/db/drizzle/down/0108_notes_down.sql',
			'DROP TABLE IF EXISTS "notes";',
		)
		expect(gates([down])).toEqual([])
		const forward = migration('packages/db/drizzle/0108_notes.sql', 'DROP TABLE IF EXISTS "notes";')
		expect(gates([forward])[0]?.kind).toBe('always_gated_sql')
	})

	it('only looks at SQL under packages/db', () => {
		expect(gates([migration('queries/ad-hoc.sql', 'DROP TABLE objects;')])).toEqual([])
	})

	it('reads only the added lines of a new file', () => {
		const file = migration('packages/db/drizzle/0108_x.sql', 'CREATE TABLE a (id int);', {
			patch: '@@ -0,0 +1,2 @@\n+++ b/packages/db/drizzle/0108_x.sql\n+CREATE TABLE a (id int);',
		})
		expect(gates([file])).toEqual([])
	})
})
