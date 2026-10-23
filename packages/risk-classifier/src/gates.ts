import { analyzeSql } from './lib/sql.js'
import type { ClassifierInput, DiffFile, SignalHit, SignalKind } from './types.js'

const MIGRATION_PREFIX = 'packages/db/'
const DOWN_MIGRATION = /^packages\/db\/drizzle\/down\//

export function isMigrationFile(path: string): boolean {
	return path.startsWith(MIGRATION_PREFIX) && path.endsWith('.sql')
}

const KIND_FOR_FINDING: Record<'core_table' | 'always_gated' | 'unparseable', SignalKind> = {
	core_table: 'core_table_gate',
	always_gated: 'always_gated_sql',
	unparseable: 'unparseable_sql',
}

function gate(kind: SignalKind, evidence: string): SignalHit {
	return { kind, weight: 0, evidence }
}

/** The SQL a new file adds. Null when the diff does not carry it (binary file, no added lines). */
function addedSql(file: DiffFile): string | null {
	if (file.patch.includes('Binary files ')) return null
	const lines = file.patch
		.split('\n')
		.filter((l) => l.startsWith('+') && !l.startsWith('+++'))
		.map((l) => l.slice(1))
	if (lines.length === 0 && file.additions > 0) return null
	return lines.join('\n')
}

function migrationGates(file: DiffFile, coreTables: string[]): SignalHit[] {
	// A diff only shows the changed hunks of an existing file, so the whole migration cannot be read.
	// An applied migration should not change anyway.
	if (file.status !== 'added') {
		return [
			gate(
				'unparseable_sql',
				`${file.path}: existing migration ${file.status}, the full SQL is not in the diff`,
			),
		]
	}
	const sql = addedSql(file)
	if (sql === null) {
		return [
			gate('unparseable_sql', `${file.path}: the SQL is not in the diff, so it cannot be read`),
		]
	}
	return analyzeSql(sql, { coreTables, isDown: DOWN_MIGRATION.test(file.path) }).map((f) =>
		gate(KIND_FOR_FINDING[f.kind], `${file.path}: ${f.detail}`),
	)
}

/**
 * The migration side of the gate: what a migration does to a core table, plus the statements that
 * are gated whatever the table. Protected paths are gated in signals.ts. Total lines changed is
 * not a gate; it is a note in the verdict.
 */
export function collectGates(input: Pick<ClassifierInput, 'files' | 'core_tables'>): SignalHit[] {
	return input.files
		.filter((f) => isMigrationFile(f.path))
		.flatMap((f) => migrationGates(f, input.core_tables))
}
