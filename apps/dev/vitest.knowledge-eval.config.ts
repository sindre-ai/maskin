import { defineConfig } from 'vitest/config'

// Local one-shot runner for the knowledge-eval harness — no DB, no global
// setup. Useful when validating fixture shape / grader logic without a
// running Postgres. The regular integration config still owns this file
// end-to-end (with its DB-heavy setup) so the harness is covered on CI.
export default defineConfig({
	test: {
		globals: true,
		include: [
			'src/__tests__/integration/knowledge-eval.test.ts',
			'src/__tests__/integration/knowledge-eval-representative.test.ts',
		],
		testTimeout: 600_000,
	},
})
