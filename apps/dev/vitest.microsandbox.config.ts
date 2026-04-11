import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		include: ['src/__tests__/integration/microsandbox-backend.test.ts'],
		testTimeout: 60000,
		hookTimeout: 60000,
		pool: 'forks',
		poolOptions: {
			forks: { singleFork: true },
		},
	},
})
