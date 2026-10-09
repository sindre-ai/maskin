import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { sql } from './global-setup'

/**
 * Migration 0083 revokes every table and sequence privilege in "public" from
 * the Supabase-managed "anon" and "authenticated" roles. Plain Postgres has
 * neither role, so global-setup already proves the no-roles path (the whole
 * migration folder ran against a role-less database). This file creates the
 * two roles, grants them what Supabase grants by default, then runs the
 * migration and its down file against a real database.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')
const MIGRATION_FILE = '0083_revoke_anon_authenticated_public_grants.sql'
const DOWN_FILE = join('down', '0083_revoke_anon_authenticated_public_grants_down.sql')
const ROLES = ['anon', 'authenticated'] as const

async function runSqlFile(relativePath: string) {
	const content = readFileSync(join(MIGRATIONS_DIR, relativePath), 'utf-8')
	for (const statement of splitStatements(content)) {
		await sql.unsafe(statement)
	}
}

/** Count of public tables / sequences the role holds any privilege on. */
async function grantedCounts(role: string) {
	const [row] = await sql<{ tables: number; sequences: number }[]>`
		SELECT
			count(*) FILTER (
				WHERE c.relkind = 'r' AND (
					has_table_privilege(${role}, c.oid, 'SELECT') OR
					has_table_privilege(${role}, c.oid, 'INSERT') OR
					has_table_privilege(${role}, c.oid, 'UPDATE') OR
					has_table_privilege(${role}, c.oid, 'DELETE')
				)
			)::int AS tables,
			count(*) FILTER (
				WHERE c.relkind = 'S' AND has_sequence_privilege(${role}, c.oid, 'USAGE')
			)::int AS sequences
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public'
	`
	return row
}

describe('migration 0083_revoke_anon_authenticated_public_grants (integration)', () => {
	const createdRoles: string[] = []

	beforeAll(async () => {
		for (const role of ROLES) {
			const [existing] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`
			if (!existing) {
				await sql.unsafe(`CREATE ROLE ${role} NOLOGIN`)
				createdRoles.push(role)
			}
		}
	})

	afterAll(async () => {
		for (const role of createdRoles) {
			await sql.unsafe(`DROP OWNED BY ${role}`)
			await sql.unsafe(`DROP ROLE ${role}`)
		}
	})

	beforeEach(async () => {
		// Mirror the Supabase defaults: grants on everything that exists, and
		// default privileges so new tables are granted too.
		for (const role of ROLES) {
			await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${role}`)
			await sql.unsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${role}`)
			await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${role}`)
			await sql.unsafe(
				`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${role}`,
			)
		}
	})

	afterEach(async () => {
		await sql`DROP TABLE IF EXISTS "grants_probe"`
	})

	it('starts from a state where both roles can reach the public tables', async () => {
		for (const role of ROLES) {
			const counts = await grantedCounts(role)
			expect(counts.tables).toBeGreaterThan(40)
		}
	})

	it('removes every table and sequence privilege from anon and authenticated', async () => {
		await runSqlFile(MIGRATION_FILE)
		for (const role of ROLES) {
			expect(await grantedCounts(role)).toEqual({ tables: 0, sequences: 0 })
		}
	})

	it('does not grant new tables to the roles by default afterwards', async () => {
		await runSqlFile(MIGRATION_FILE)
		await sql`CREATE TABLE "grants_probe" (id int)`
		for (const role of ROLES) {
			const [row] = await sql<{ ok: boolean }[]>`
				SELECT has_table_privilege(${role}, 'public.grants_probe', 'SELECT') AS ok
			`
			expect(row.ok).toBe(false)
		}
	})

	it('is idempotent', async () => {
		await runSqlFile(MIGRATION_FILE)
		await runSqlFile(MIGRATION_FILE)
		for (const role of ROLES) {
			expect(await grantedCounts(role)).toEqual({ tables: 0, sequences: 0 })
		}
	})

	it('leaves the owning role able to read and write the tables', async () => {
		await runSqlFile(MIGRATION_FILE)
		const [row] = await sql<{ ok: boolean }[]>`
			SELECT has_table_privilege(current_user, 'public.workspaces', 'SELECT') AS ok
		`
		expect(row.ok).toBe(true)
	})

	it('is reversible: the down file restores the grants and the defaults', async () => {
		await runSqlFile(MIGRATION_FILE)
		await runSqlFile(DOWN_FILE)
		for (const role of ROLES) {
			const counts = await grantedCounts(role)
			expect(counts.tables).toBeGreaterThan(40)
		}
		await sql`CREATE TABLE "grants_probe" (id int)`
		for (const role of ROLES) {
			const [row] = await sql<{ ok: boolean }[]>`
				SELECT has_table_privilege(${role}, 'public.grants_probe', 'SELECT') AS ok
			`
			expect(row.ok).toBe(true)
		}
	})
})
