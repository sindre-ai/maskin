import { sql } from './global-setup'

/**
 * Migration 0134 adds sessions_open_status_idx for the session watchdog's status lookups that
 * carry no workspace_id. The planner only uses a partial index when the query's status condition
 * lies inside the index predicate, so the statuses listed in it are what makes it work.
 */
describe('migration 0134_sessions_open_status_idx (integration)', () => {
	it('indexes status and updated_at over exactly the live and paused statuses', async () => {
		const [row] = await sql<{ indexdef: string }[]>`
			SELECT indexdef FROM pg_indexes
			WHERE schemaname = 'public'
			  AND tablename = 'sessions'
			  AND indexname = 'sessions_open_status_idx'
		`
		expect(row).toBeDefined()
		const def = row?.indexdef ?? ''
		// Postgres rewrites `status IN (...)` to `status = ANY (ARRAY[...])` in indexdef.
		expect(def).toMatch(/\(status, updated_at\)/)
		for (const status of ['pending', 'queued', 'running', 'paused']) {
			expect(def).toContain(`'${status}'`)
		}
		for (const status of ['completed', 'failed', 'timeout', 'user_stopped']) {
			expect(def).not.toContain(`'${status}'`)
		}
	})
})
