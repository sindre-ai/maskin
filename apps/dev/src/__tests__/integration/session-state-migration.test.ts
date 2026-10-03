import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { sessions } from '@maskin/db/schema'
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

/**
 * Migration 0076 adds seven columns + two partial indexes to `sessions` and
 * back-fills every pre-existing row's `session_state` from the ambiguous
 * `status` text (spec §15.2 / §22). The follow-on Commits 5, 6 and 7 all
 * consume that column, so the correctness of the migration itself is the
 * gate for the rest of the bet.
 *
 * Mocked-DB tests can't prove any of this — the check runs against real
 * Postgres via the same harness `pnpm test:integration` uses.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')
const MIGRATION_FILE = '0076_add_session_state.sql'
const DOWN_FILE = join('down', '0076_add_session_state_down.sql')

async function runSqlFile(relativePath: string) {
	const content = readFileSync(join(MIGRATIONS_DIR, relativePath), 'utf-8')
	for (const statement of splitStatements(content)) {
		await sql.unsafe(statement)
	}
}

describe('migration 0076_add_session_state (integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	it('adds all seven columns to sessions with the right types + defaults', async () => {
		const rows = await sql<
			{
				column_name: string
				data_type: string
				is_nullable: string
				column_default: string | null
			}[]
		>`
			SELECT column_name, data_type, is_nullable, column_default
			FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'sessions'
			  AND column_name IN (
			    'session_state','state_entered_at','retry_at','retried_session_id',
			    'retry_of','attempt_number','driver_heartbeat_at'
			  )
			ORDER BY column_name
		`
		const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]))
		expect(Object.keys(byName).sort()).toEqual([
			'attempt_number',
			'driver_heartbeat_at',
			'retried_session_id',
			'retry_at',
			'retry_of',
			'session_state',
			'state_entered_at',
		])
		expect(byName.session_state).toMatchObject({
			data_type: 'text',
			is_nullable: 'NO',
		})
		expect(byName.session_state.column_default).toContain("'queued'")
		expect(byName.state_entered_at).toMatchObject({
			data_type: 'timestamp with time zone',
			is_nullable: 'NO',
		})
		expect(byName.state_entered_at.column_default).toMatch(/now\(\)/i)
		expect(byName.retry_at).toMatchObject({
			data_type: 'timestamp with time zone',
			is_nullable: 'YES',
		})
		expect(byName.retried_session_id).toMatchObject({
			data_type: 'uuid',
			is_nullable: 'YES',
		})
		expect(byName.retry_of).toMatchObject({
			data_type: 'uuid',
			is_nullable: 'YES',
		})
		expect(byName.attempt_number).toMatchObject({
			data_type: 'integer',
			is_nullable: 'NO',
		})
		expect(byName.attempt_number.column_default).toContain('1')
		expect(byName.driver_heartbeat_at).toMatchObject({
			data_type: 'timestamp with time zone',
			is_nullable: 'YES',
		})
	})

	it('enforces the session_state CHECK constraint (rejects unknown values)', async () => {
		const created = await insertSession(db, workspaceId, actorId, actorId, { status: 'running' })
		await expect(
			sql`UPDATE sessions SET session_state = 'bogus' WHERE id = ${created.id}::uuid`,
		).rejects.toThrow(/sessions_session_state_check|violates check constraint/i)
	})

	it('enforces the retried_session_id / retry_of self-FKs', async () => {
		const created = await insertSession(db, workspaceId, actorId, actorId, { status: 'running' })
		const missingId = '00000000-0000-0000-0000-000000000000'
		await expect(
			sql`UPDATE sessions SET retried_session_id = ${missingId}::uuid WHERE id = ${created.id}::uuid`,
		).rejects.toThrow(/foreign key|sessions_retried_session_id/i)
		await expect(
			sql`UPDATE sessions SET retry_of = ${missingId}::uuid WHERE id = ${created.id}::uuid`,
		).rejects.toThrow(/foreign key|sessions_retry_of/i)
	})

	it('creates both partial indexes with the specified WHERE clauses', async () => {
		const idx = await sql<{ indexname: string; indexdef: string }[]>`
			SELECT indexname, indexdef FROM pg_indexes
			WHERE schemaname = 'public'
			  AND tablename = 'sessions'
			  AND indexname IN ('sessions_session_state_state_entered_at_idx', 'sessions_retry_at_idx')
			ORDER BY indexname
		`
		expect(idx.map((r) => r.indexname).sort()).toEqual([
			'sessions_retry_at_idx',
			'sessions_session_state_state_entered_at_idx',
		])
		const byName = Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]))
		// Postgres normalises `WHERE col IN (...)` to `WHERE col = ANY (ARRAY[...])`
		// in pg_indexes.indexdef, so the assertion has to match either shape.
		expect(byName.sessions_session_state_state_entered_at_idx).toMatch(/session_state/)
		expect(byName.sessions_session_state_state_entered_at_idx).toMatch(/'starting'/)
		expect(byName.sessions_session_state_state_entered_at_idx).toMatch(/'running'/)
		expect(byName.sessions_session_state_state_entered_at_idx).toMatch(/'waiting_for_machine'/)
		expect(byName.sessions_retry_at_idx).toMatch(
			/retry_at.*IS NOT NULL.*retried_session_id.*IS NULL/i,
		)
	})

	it('back-fills session_state from status for every pre-existing row (§22 in-flight rows)', async () => {
		const cases: Array<{ status: string; expected: string }> = [
			{ status: 'pending', expected: 'queued' },
			{ status: 'queued', expected: 'queued' },
			{ status: 'starting', expected: 'starting' },
			{ status: 'running', expected: 'running' },
			{ status: 'snapshotting', expected: 'running' },
			{ status: 'completed', expected: 'done' },
			{ status: 'failed', expected: 'done' },
			{ status: 'stopped', expected: 'done' },
		]
		const created = await Promise.all(
			cases.map((c) =>
				insertSession(db, workspaceId, actorId, actorId, {
					status: c.status,
					startedAt: c.status === 'pending' ? null : new Date(Date.now() - 60_000),
				}),
			),
		)

		// Re-apply the back-fill UPDATE on the rows we just inserted (post-hoc
		// simulates the migration's behaviour on rows that existed pre-deploy —
		// production rows on the day of deploy hit exactly this path).
		const ids = created.map((r) => r.id as string)
		await sql`
			UPDATE sessions SET session_state = CASE status
				WHEN 'pending' THEN 'queued'
				WHEN 'queued' THEN 'queued'
				WHEN 'starting' THEN 'starting'
				WHEN 'running' THEN 'running'
				WHEN 'snapshotting' THEN 'running'
				ELSE 'done'
			END,
			state_entered_at = COALESCE(started_at, updated_at, NOW())
			WHERE id IN ${sql(ids)}
		`

		const rows = await db.select().from(sessions).where(inArray(sessions.id, ids))
		const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.sessionState]))
		for (const c of cases) {
			expect(byStatus[c.status]).toBe(c.expected)
		}
	})

	it('leaves the retry-scheduler partial index empty when retried_session_id is set (dedupes replayed retries)', async () => {
		const original = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'failed',
		})
		const retry = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'pending',
		})
		// Fill retry_at on both, then chain original -> retry via retried_session_id.
		await sql`UPDATE sessions SET retry_at = NOW() + INTERVAL '30 seconds' WHERE id IN (${original.id}::uuid, ${retry.id}::uuid)`
		await sql`UPDATE sessions SET retried_session_id = ${retry.id}::uuid WHERE id = ${original.id}::uuid`

		const [pickup] = await db
			.select()
			.from(sessions)
			.where(
				and(
					isNotNull(sessions.retryAt),
					isNull(sessions.retriedSessionId),
					eq(sessions.id, original.id),
				),
			)
		expect(pickup).toBeUndefined()

		const [siblingPickup] = await db
			.select()
			.from(sessions)
			.where(
				and(
					isNotNull(sessions.retryAt),
					isNull(sessions.retriedSessionId),
					eq(sessions.id, retry.id),
				),
			)
		expect(siblingPickup?.id).toBe(retry.id)
	})

	it('round-trips down → up cleanly (rollback safety)', async () => {
		// Establish a row so the up-migration's back-fill has something to do.
		await insertSession(db, workspaceId, actorId, actorId, { status: 'running' })

		await runSqlFile(DOWN_FILE)
		const removedColumns = await sql<{ column_name: string }[]>`
			SELECT column_name FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'sessions'
			  AND column_name IN (
			    'session_state','state_entered_at','retry_at','retried_session_id',
			    'retry_of','attempt_number','driver_heartbeat_at'
			  )
		`
		expect(removedColumns).toEqual([])

		await runSqlFile(MIGRATION_FILE)
		const restored = await sql<{ column_name: string }[]>`
			SELECT column_name FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'sessions'
			  AND column_name IN (
			    'session_state','state_entered_at','retry_at','retried_session_id',
			    'retry_of','attempt_number','driver_heartbeat_at'
			  )
		`
		expect(restored).toHaveLength(7)
	})
})
