import { readdirSync } from 'node:fs'

export function listMigrationFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
		.sort()
}

// Splits a migration file's contents into individually-executable statements
// on drizzle-kit's `--> statement-breakpoint` marker.
//
// This matters because Postgres implicitly wraps a multi-statement simple-query
// string in a single transaction block. A migration that uses CREATE PROCEDURE +
// CALL to COMMIT mid-loop (packages/db/MIGRATIONS.md Rule 2) fails with
// "invalid transaction termination" if it's sent bundled with other statements —
// the CALL must be the only statement in its query message to run at the top
// level, where its internal COMMIT is legal.
export function splitStatements(content: string): string[] {
	return content
		.split('--> statement-breakpoint')
		.map((s) => s.trim())
		.filter(Boolean)
}
