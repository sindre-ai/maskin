import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		include: ['src/__tests__/integration/**/*.test.ts'],
		setupFiles: ['src/__tests__/integration/global-setup.ts'],
		testTimeout: 30000,
		// Match testTimeout: the per-file beforeAll drops the schema and replays
		// every migration in packages/db/drizzle/ before the first test can run.
		// Under CI load that occasionally exceeds Vitest's 10s hook default and
		// fails whichever test file happens to be slowest to start.
		hookTimeout: 30000,
		pool: 'forks',
		poolOptions: {
			forks: { singleFork: true },
		},
	},
})
