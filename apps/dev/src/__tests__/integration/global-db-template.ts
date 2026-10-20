import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import postgres from 'postgres'

// Vitest `globalSetup`: runs once per `vitest run`, not once per test file.
//
// Replays every migration into a template database a single time. Each test
// file then clones it with `CREATE DATABASE ... TEMPLATE` (a file-level copy,
// see global-setup.ts) instead of dropping the schema and replaying all
// migrations itself, which cost ~2s per file x ~200 files and made files unable
// to run in parallel because they shared one database.

export const TEMPLATE_DB = 'maskin_it_template'

export function withDatabase(url: string, database: string): string {
	const u = new URL(url)
	u.pathname = `/${database}`
	return u.toString()
}

export async function setup() {
	const baseUrl = process.env.DATABASE_URL
	if (!baseUrl) {
		throw new Error(
			'DATABASE_URL is required for integration tests. Run: docker-compose up postgres -d',
		)
	}

	const admin = postgres(baseUrl, { max: 1, onnotice: () => {} })
	await admin.unsafe(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`)
	await admin.unsafe(`CREATE DATABASE "${TEMPLATE_DB}"`)
	await admin.end()

	const sql = postgres(withDatabase(baseUrl, TEMPLATE_DB), { max: 1, onnotice: () => {} })
	try {
		// Mirror packages/db/src/migrate.ts: the tracking table must exist so any
		// migration or rollback file that touches it (e.g. reversibility tests)
		// runs identically to production.
		await sql`
			CREATE TABLE IF NOT EXISTS "_migrations" (
				"name" text PRIMARY KEY,
				"applied_at" timestamp with time zone DEFAULT now()
			)
		`

		const __dirname = dirname(fileURLToPath(import.meta.url))
		const migrationsDir = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')
		const files = readdirSync(migrationsDir)
			.filter((f) => f.endsWith('.sql'))
			.sort()

		for (const file of files) {
			const content = readFileSync(join(migrationsDir, file), 'utf-8')
			// One statement per query message — see packages/db/src/migrate-utils.ts.
			for (const statement of splitStatements(content)) {
				await sql.unsafe(statement)
			}
			await sql`INSERT INTO "_migrations" ("name") VALUES (${file}) ON CONFLICT DO NOTHING`
		}
	} finally {
		// CREATE DATABASE ... TEMPLATE fails while anyone is connected to the template.
		await sql.end()
	}
}

export async function teardown() {
	const baseUrl = process.env.DATABASE_URL
	if (!baseUrl) return
	const admin = postgres(baseUrl, { max: 1, onnotice: () => {} })
	try {
		await admin.unsafe(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`)
	} finally {
		await admin.end()
	}
}
