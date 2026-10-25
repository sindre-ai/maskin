import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { sql } from './global-setup'

/**
 * Migration 0111 turns on row-level security on every table in "public".
 * global-setup has already applied it by the time these tests run, so each test
 * starts from the down file and re-applies forward. The app role owns the
 * tables, so it keeps full access; anon and authenticated, even with a grant,
 * see no rows. The Keychain role maskin_keychain_app (a non-owner) keeps its
 * access to the audit log through its one policy.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')
const MIGRATION_FILE = '0111_enable_rls_public_tables.sql'
const DOWN_FILE = join('down', '0111_enable_rls_public_tables_down.sql')
const ROLES = ['anon', 'authenticated'] as const

async function runSqlFile(relativePath: string) {
	const content = readFileSync(join(MIGRATIONS_DIR, relativePath), 'utf-8')
	for (const statement of splitStatements(content)) {
		await sql.unsafe(statement)
	}
}

/** Public tables with row security on, and the total number of public tables. */
async function rlsCounts() {
	const [row] = await sql<{ enabled: number; total: number }[]>`
		SELECT
			count(*) FILTER (WHERE c.relrowsecurity)::int AS enabled,
			count(*)::int AS total
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
	`
	return row
}

/** Rows of "workspaces" the role can see, reading as that role. */
async function rowsVisibleTo(role: string) {
	return sql.begin(async (tx) => {
		await tx.unsafe(`SET LOCAL ROLE ${role}`)
		const [row] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM workspaces`
		return row.n
	})
}

describe('migration 0111_enable_rls_public_tables (integration)', () => {
	const createdRoles: string[] = []

	beforeAll(async () => {
		for (const role of ROLES) {
			const [existing] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`
			if (!existing) {
				await sql.unsafe(`CREATE ROLE ${role} NOLOGIN`)
				createdRoles.push(role)
			}
			// Without USAGE the role cannot resolve table names at all.
			await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`)
		}
	})

	afterAll(async () => {
		await runSqlFile(MIGRATION_FILE)
		for (const role of createdRoles) {
			await sql.unsafe(`DROP OWNED BY ${role}`)
			await sql.unsafe(`DROP ROLE ${role}`)
		}
	})

	beforeEach(async () => {
		await runSqlFile(DOWN_FILE)
		await sql`INSERT INTO workspaces (name) VALUES ('rls-probe')`
		// A regression the migration must survive: the roles hold a grant again.
		for (const role of ROLES) {
			await sql.unsafe(`GRANT SELECT ON workspaces TO ${role}`)
		}
	})

	afterEach(async () => {
		for (const role of ROLES) {
			await sql.unsafe(`REVOKE SELECT ON workspaces FROM ${role}`)
		}
		await sql`DELETE FROM workspaces WHERE name = 'rls-probe'`
	})

	it('starts from a state where row security is off and the roles can read rows', async () => {
		expect((await rlsCounts()).enabled).toBe(0)
		for (const role of ROLES) {
			expect(await rowsVisibleTo(role)).toBeGreaterThan(0)
		}
	})

	it('turns on row security for every table in public', async () => {
		await runSqlFile(MIGRATION_FILE)
		const { enabled, total } = await rlsCounts()
		expect(total).toBeGreaterThan(40)
		expect(enabled).toBe(total)
	})

	it('denies anon and authenticated even when a grant is present', async () => {
		await runSqlFile(MIGRATION_FILE)
		for (const role of ROLES) {
			expect(await rowsVisibleTo(role)).toBe(0)
		}
	})

	it('leaves the owning role able to read and write', async () => {
		await runSqlFile(MIGRATION_FILE)
		const [read] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM workspaces`
		expect(read.n).toBeGreaterThan(0)
		await sql`INSERT INTO workspaces (name) VALUES ('rls-probe-write')`
		await sql`DELETE FROM workspaces WHERE name = 'rls-probe-write'`
	})

	it('keeps the Keychain app role able to write and read the audit log', async () => {
		await runSqlFile(MIGRATION_FILE)
		const [ws] = await sql<{ id: string }[]>`SELECT id FROM workspaces WHERE name = 'rls-probe'`
		const requestId = `rls-probe-${randomUUID()}`
		const seen = await sql.begin(async (tx) => {
			await tx.unsafe('SET LOCAL ROLE maskin_keychain_app')
			await tx`
				INSERT INTO credential_access_log (workspace_id, integration_id, actor_id, request_id)
				VALUES (${ws.id}, ${randomUUID()}, ${randomUUID()}, ${requestId})
			`
			const [row] = await tx<{ n: number }[]>`
				SELECT count(*)::int AS n FROM credential_access_log WHERE request_id = ${requestId}
			`
			return row.n
		})
		expect(seen).toBe(1)
	})

	it('is idempotent and leaves no helper procedure behind', async () => {
		await runSqlFile(MIGRATION_FILE)
		await runSqlFile(MIGRATION_FILE)
		const { enabled, total } = await rlsCounts()
		expect(enabled).toBe(total)
		const [proc] = await sql<{ n: number }[]>`
			SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'enable_rls_public_tables'
		`
		expect(proc.n).toBe(0)
	})

	it('is reversible: the down file turns row security off again', async () => {
		await runSqlFile(MIGRATION_FILE)
		await runSqlFile(DOWN_FILE)
		expect((await rlsCounts()).enabled).toBe(0)
		for (const role of ROLES) {
			expect(await rowsVisibleTo(role)).toBeGreaterThan(0)
		}
	})
})
