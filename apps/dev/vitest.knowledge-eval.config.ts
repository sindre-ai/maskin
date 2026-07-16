import { defineConfig } from 'vitest/config'

// Local one-shot runner for the knowledge-eval harness — no DB, no global
// setup. Useful when validating fixture shape / grader logic (T4), router
// mechanism / ship-metric on the 20-pair fixture (T5-followup), the
// representative paired runner (T8), and the router paired-run against the
// representative harness (T10) without a running Postgres. The regular
// integration config still owns these files end-to-end (with its DB-heavy
// setup) so the harness is covered on CI.
export default defineConfig({
	test: {
		globals: true,
		include: [
			'src/__tests__/integration/knowledge-eval.test.ts',
			'src/__tests__/integration/knowledge-eval-router.test.ts',
			'src/__tests__/integration/knowledge-eval-representative.test.ts',
			'src/__tests__/integration/knowledge-eval-representative-router.test.ts',
			'src/__tests__/integration/knowledge-eval-pilot.test.ts',
		],
		testTimeout: 600_000,
	},
})
