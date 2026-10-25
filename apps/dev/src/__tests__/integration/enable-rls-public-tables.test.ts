import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { CREDENTIAL_LOG_ROLE } from '../../lib/integrations/credential-audit'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

/**
 * Migration 0111 turns on row-level security on every table in "public",
 * with no policies except two for the keychain audit role on
 * credential_access_log. global-setup has already applied it by the time these
 * tests run, so each test starts from the down file and re-applies forward.
 * The app role owns the tables, so it keeps full access; anon and
 * authenticated, even with a grant, see no rows. getCredential drops to the
 * non-owner keychain role to write its audit row, so that role must still work.
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

/** Seeds an integration and returns what a credential_access_log row needs. */
async function seedAuditTarget() {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	const [integration] = await sql<{ id: string }[]>`
		INSERT INTO integrations (workspace_id, provider, status, credentials, created_by)
		VALUES (${ws.id}, 'fake-provider', 'active', 'fake-ciphertext', ${actorId})
		RETURNING id
	`
	return { workspaceId: ws.id, integrationId: integration.id, actorId }
}

// Runs first, before any test below touches the down file: this is the state a
// fresh database is in after the real runner has applied every migration in
// order. A migration number below one of these tables would leave it uncovered.
describe('migration 0111_enable_rls_public_tables, as applied by the runner (integration)', () => {
	it('covers tables created by the migrations just before it', async () => {
		const rows = await sql<{ relname: string; relrowsecurity: boolean }[]>`
			SELECT c.relname, c.relrowsecurity
			FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'public'
				AND c.relname IN ('device_auth_codes', 'web_push_subscriptions', 'notification_preferences', 'linkedin_actions')
		`
		expect(rows).toHaveLength(4)
		for (const row of rows) {
			expect(row.relrowsecurity, row.relname).toBe(true)
		}
	})
})

describe('migration 0111_enable_rls_public_tables (integration)', () => {
	const createdRoles: string[] = []

	beforeAll(async () => {
		for (const role of ROLES) {
			const [existing] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`
			if (!existing) {
				await sql.unsafe(`CREATE ROLE ${role} NOLOGIN`)
				createdRoles.push(role)
			}
			// global-setup recreates "public", which leaves it without USAGE for other
			// roles; without it the role cannot resolve table names at all.
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

	it('lets the keychain audit role insert and read credential_access_log, as getCredential does', async () => {
		await runSqlFile(MIGRATION_FILE)
		const s = await seedAuditTarget()
		await sql.begin(async (tx) => {
			await tx.unsafe(`SET LOCAL ROLE ${CREDENTIAL_LOG_ROLE}`)
			await tx`INSERT INTO credential_access_log ${tx({
				workspace_id: s.workspaceId,
				integration_id: s.integrationId,
				actor_id: s.actorId,
				request_id: 'rls-keychain-role',
			})}`
			const rows = await tx<{ row_hash: string }[]>`
				SELECT row_hash FROM credential_access_log WHERE workspace_id = ${s.workspaceId}
			`
			expect(rows).toHaveLength(1)
			// The chain trigger ran, and it read the previous row as this role.
			expect(rows[0].row_hash).not.toBe('')
		})
	})

	it('still denies anon and authenticated on credential_access_log, even with a grant', async () => {
		await runSqlFile(MIGRATION_FILE)
		const s = await seedAuditTarget()
		await sql`
			INSERT INTO credential_access_log (workspace_id, integration_id, actor_id, request_id)
			VALUES (${s.workspaceId}, ${s.integrationId}, ${s.actorId}, 'rls-probe')
		`
		for (const role of ROLES) {
			await sql.unsafe(`GRANT SELECT ON credential_access_log TO ${role}`)
			try {
				const n = await sql.begin(async (tx) => {
					await tx.unsafe(`SET LOCAL ROLE ${role}`)
					const [row] = await tx<{ n: number }[]>`
						SELECT count(*)::int AS n FROM credential_access_log
					`
					return row.n
				})
				expect(n).toBe(0)
			} finally {
				await sql.unsafe(`REVOKE SELECT ON credential_access_log FROM ${role}`)
			}
		}
	})

	it('creates only the two keychain-role policies, nothing for any other role', async () => {
		await runSqlFile(MIGRATION_FILE)
		const policies = await sql<{ tablename: string; cmd: string; roles: string[] }[]>`
			SELECT tablename, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public'
		`
		expect(policies.map((p) => p.cmd).sort()).toEqual(['INSERT', 'SELECT'])
		for (const p of policies) {
			expect(p.tablename).toBe('credential_access_log')
			expect(p.roles).toEqual([CREDENTIAL_LOG_ROLE])
		}
	})

	it('is reversible: the down file turns row security off and drops the policies', async () => {
		await runSqlFile(MIGRATION_FILE)
		await runSqlFile(DOWN_FILE)
		expect((await rlsCounts()).enabled).toBe(0)
		const [policies] = await sql<{ n: number }[]>`
			SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'
		`
		expect(policies.n).toBe(0)
		for (const role of ROLES) {
			expect(await rowsVisibleTo(role)).toBeGreaterThan(0)
		}
	})
})
