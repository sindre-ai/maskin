import { defineConfig } from 'vitest/config'

// Local one-shot runner for the knowledge-eval harness — no DB, no global
// setup. Useful when validating fixture shape / grader logic (T4), router
// mechanism / ship-metric (T5), and the representative paired runner (T8)
// without a running Postgres. The regular integration config still owns
// these files end-to-end (with its DB-heavy setup) so the harness is
// covered on CI.
export default defineConfig({
	test: {
		globals: true,
		include: [
			'src/__tests__/integration/knowledge-eval.test.ts',
			'src/__tests__/integration/knowledge-eval-router.test.ts',
			'src/__tests__/integration/knowledge-eval-representative.test.ts',
		],
		testTimeout: 600_000,
	},
})
