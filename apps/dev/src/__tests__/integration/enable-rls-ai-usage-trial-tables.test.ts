import { sql } from './global-setup'

/**
 * Migration 0166 turns on row-level security for three tables created after the
 * blanket pass in 0111. global-setup has applied every migration by the time this
 * runs. The app role owns the tables, so it keeps full access (the trial-card,
 * trial-promo and workspace-ai-usage integration tests read and write them).
 */
describe('migration 0166_enable_rls_ai_usage_trial_tables (integration)', () => {
	it('has row security on, with no policies, for the three tables', async () => {
		const rows = await sql<
			{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
		>`
			SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
			FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'public'
				AND c.relname IN ('workspace_ai_usage', 'trial_cards', 'trial_promo_codes')
		`
		expect(rows).toHaveLength(3)
		for (const row of rows) {
			expect(row.relrowsecurity, row.relname).toBe(true)
			expect(row.relforcerowsecurity, row.relname).toBe(false)
		}
		const [policies] = await sql<{ n: number }[]>`
			SELECT count(*)::int AS n FROM pg_policies
			WHERE schemaname = 'public'
				AND tablename IN ('workspace_ai_usage', 'trial_cards', 'trial_promo_codes')
		`
		expect(policies.n).toBe(0)
	})
})
