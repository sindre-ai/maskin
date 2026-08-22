import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		// Headroom for the full monorepo run, where many vitest workers + tsc +
		// the web test suite compete for CPU and the default 5s can be missed
		// even though individual tests are fast in isolation.
		testTimeout: 20_000,
		// hookTimeout is a separate setting from testTimeout and defaults to
		// 10s — beforeEach hooks that do a dynamic import() (paying the cost of
		// compiling that module's full dependency graph on first use) can miss
		// that under the same CI contention testTimeout was raised for.
		hookTimeout: 20_000,
		setupFiles: ['./src/__tests__/register-extensions.ts'],
		exclude: ['src/__tests__/integration/**', 'node_modules/**', 'dist/**'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov'],
			include: ['src/routes/**', 'src/lib/**', 'src/middleware/**'],
			thresholds: {
				lines: 60,
				branches: 60,
				functions: 60,
				statements: 60,
			},
		},
	},
})
