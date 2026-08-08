import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { type Database, createDb } from '../../db/connection'

// ── Test database resolution ────────────────────────────────────────────────
//
// vaerksted-sync's real deployment target is the same dedicated Supabase
// project's Postgres vaerksted-auth uses, under its own logical schema
// (design doc §10) — not reachable from this dev sandbox (no live Supabase
// credentials here). Rather than skip integration testing entirely, this
// falls back to the same local Postgres container Maskin's own dev stack
// already runs (`docker-compose up postgres`, the one `DATABASE_URL` points
// at) — but in a completely separate, throwaway **database**
// (`vaerksted_sync_test`), distinct from both Maskin's own `maskin`
// database AND vaerksted-auth's `vaerksted_auth_test` throwaway database.
// Per the M4 task's scope rules: this must never touch or migrate Maskin's
// or vaerksted-auth's actual schemas.
//
// Resolution order:
//   1. VAERKSTED_SYNC_DATABASE_URL, if set — the real target in CI/prod.
//   2. Derived from DATABASE_URL (swap the database name only) — local dev
//      convenience, reusing the same Postgres server/credentials Maskin's
//      dev stack already has running, in an isolated database.
//   3. Neither set — tests are skipped (see below), not silently no-op'd.
function resolveTestDatabaseUrl(): string | null {
	if (process.env.VAERKSTED_SYNC_DATABASE_URL) {
		return process.env.VAERKSTED_SYNC_DATABASE_URL
	}
	if (process.env.DATABASE_URL) {
		const url = new URL(process.env.DATABASE_URL)
		url.pathname = '/vaerksted_sync_test'
		return url.toString()
	}
	return null
}

export const testDatabaseUrl = resolveTestDatabaseUrl()

export let db: Database
export let sql: ReturnType<typeof postgres>

function splitStatements(content: string): string[] {
	return content
		.split('--> statement-breakpoint')
		.map((s) => s.trim())
		.filter(Boolean)
}

beforeAll(async () => {
	if (!testDatabaseUrl) {
		// No real Postgres reachable — every test in this suite uses
		// `describe.skipIf(!testDatabaseUrl)` (see sync.test.ts), so this is a
		// deliberate no-op, not a silent skip of a check that should have run.
		return
	}

	// If we derived the URL from DATABASE_URL (local dev fallback), the
	// `vaerksted_sync_test` database itself may not exist yet — create it via
	// a connection to the server's default maintenance database first.
	if (!process.env.VAERKSTED_SYNC_DATABASE_URL && process.env.DATABASE_URL) {
		const adminUrl = new URL(process.env.DATABASE_URL)
		adminUrl.pathname = '/postgres'
		const admin = postgres(adminUrl.toString())
		try {
			await admin`CREATE DATABASE vaerksted_sync_test`
		} catch (err) {
			// 42P04 = database already exists — fine, reuse it.
			if ((err as { code?: string }).code !== '42P04') throw err
		} finally {
			await admin.end()
		}
	}

	sql = postgres(testDatabaseUrl)
	db = createDb(testDatabaseUrl)

	// Drop and recreate schema so migrations are idempotent across runs —
	// mirrors apps/vaerksted-auth/src/__tests__/integration/global-setup.ts's
	// pattern, scoped to this throwaway database only.
	await sql`DROP SCHEMA public CASCADE`
	await sql`CREATE SCHEMA public`

	const __dirname = dirname(fileURLToPath(import.meta.url))
	const migrationsDir = join(__dirname, '..', '..', '..', 'drizzle')
	const files = readdirSync(migrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort()

	for (const file of files) {
		const content = readFileSync(join(migrationsDir, file), 'utf-8')
		for (const statement of splitStatements(content)) {
			await sql.unsafe(statement)
		}
	}
})

beforeEach(async () => {
	if (!testDatabaseUrl) return
	await sql`TRUNCATE sync_blob, consumed_nonce`
})

afterAll(async () => {
	if (!testDatabaseUrl) return
	await sql.end()
})
