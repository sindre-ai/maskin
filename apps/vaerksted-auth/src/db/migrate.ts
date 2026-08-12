import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

// Mirrors `packages/db/src/migrate.ts`'s runner shape, pointed at this app's
// own, separate migration folder (`apps/vaerksted-auth/drizzle/`). Statements
// are split and run individually rather than as one batch — see
// `packages/db/src/migrate-utils.ts` for the rationale this mirrors (not
// imported directly, to keep zero code-level dependency on `packages/db`).
// This file lives at src/db/migrate.ts; the migration folder is at the
// package root (apps/vaerksted-auth/drizzle/) — see drizzle.config.ts's
// comment on why `out` is './drizzle' relative to package root, not this file.
const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(__dirname, '..', '..', 'drizzle')

const databaseUrl = process.env.VAERKSTED_AUTH_DATABASE_URL
if (!databaseUrl) {
	console.error('VAERKSTED_AUTH_DATABASE_URL is not set — cannot run migrations')
	process.exit(1)
}

const sql = postgres(databaseUrl, { prepare: false })

await sql`
	CREATE TABLE IF NOT EXISTS "_migrations" (
		"name" text PRIMARY KEY,
		"applied_at" timestamp with time zone DEFAULT now()
	)
`

const applied = new Set((await sql`SELECT name FROM "_migrations"`).map((r) => r.name))

const files = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()

/**
 * Splits a migration file into individually-executable statements on
 * `-->` drizzle statement-breakpoint markers, falling back to the whole file
 * when no marker is present. Kept local (not imported from `packages/db`) to
 * preserve this app's zero-code-dependency requirement on Maskin's own DB
 * package — see design doc §4.
 */
function splitStatements(content: string): string[] {
	return content
		.split('--> statement-breakpoint')
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
}

for (const file of files) {
	if (applied.has(file)) {
		console.log(`Skipping (already applied): ${file}`)
		continue
	}

	const content = readFileSync(join(migrationsDir, file), 'utf-8')
	console.log(`Running migration: ${file}`)

	for (const statement of splitStatements(content)) {
		try {
			await sql.unsafe(statement)
		} catch (err: unknown) {
			const code = (err as { code?: string }).code
			// 42P07 = relation already exists, 42701 = column already exists,
			// 42710 = object (e.g. constraint) already exists.
			if (code === '42P07' || code === '42701' || code === '42710') {
				console.log(`  Already applied (marking as done): ${file}`)
			} else {
				throw err
			}
		}
	}

	await sql`INSERT INTO "_migrations" (name) VALUES (${file})`
}

console.log('Migrations complete')
await sql.end()
process.exit(0)
