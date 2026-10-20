import { defineConfig } from 'vitest/config'

// Each test file runs against its own database cloned from a template that
// global-db-template.ts migrates once, so files are isolated and can run in
// parallel. INTEGRATION_WORKERS caps the number of concurrent files (each one
// holds a few Postgres connections; keep workers x ~15 under max_connections).
const workers = Number(process.env.INTEGRATION_WORKERS)

export default defineConfig({
	test: {
		globals: true,
		include: ['src/__tests__/integration/**/*.test.ts'],
		globalSetup: ['src/__tests__/integration/global-db-template.ts'],
		setupFiles: ['src/extensions.ts', 'src/__tests__/integration/global-setup.ts'],
		testTimeout: 30000,
		pool: 'forks',
		poolOptions: {
			forks: { maxForks: Number.isFinite(workers) && workers > 0 ? workers : 4, minForks: 1 },
		},
	},
})
