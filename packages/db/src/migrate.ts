import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(__dirname, '..', 'drizzle')

// biome-ignore lint/style/noNonNullAssertion: required env var for CLI
const sql = postgres(process.env.POSTGRES_URL || process.env.DATABASE_URL!)

// Create migrations tracking table if it doesn't exist
await sql`
	CREATE TABLE IF NOT EXISTS "_migrations" (
		"name" text PRIMARY KEY,
		"applied_at" timestamp with time zone DEFAULT now()
	)
`

// Get already-applied migrations
const applied = new Set((await sql`SELECT name FROM "_migrations"`).map((r) => r.name))

const files = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()

for (const file of files) {
	if (applied.has(file)) {
		console.log(`Skipping (already applied): ${file}`)
		continue
	}

	const content = readFileSync(join(migrationsDir, file), 'utf-8')
	console.log(`Running migration: ${file}`)

	try {
		await sql.unsafe(content)
	} catch (err: unknown) {
		const code = (err as { code?: string }).code
		// 42P07 = relation already exists, 42701 = column already exists
		// This handles existing DBs that predate migration tracking
		if (code === '42P07' || code === '42701') {
			console.log(`  Already applied (marking as done): ${file}`)
		} else {
			throw err
		}
	}

	await sql`INSERT INTO "_migrations" (name) VALUES (${file})`
}

console.log('Migrations complete')
await sql.end()
process.exit(0)
