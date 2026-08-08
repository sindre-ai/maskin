import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		include: ['src/__tests__/integration/**/*.test.ts'],
		setupFiles: ['src/__tests__/integration/global-setup.ts'],
		testTimeout: 30000,
		pool: 'forks',
		poolOptions: {
			forks: { singleFork: true },
		},
	},
})
