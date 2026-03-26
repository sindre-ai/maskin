import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		setupFiles: ['./src/__tests__/register-extensions.ts'],
		exclude: ['src/__tests__/integration/**', 'node_modules/**', 'dist/**'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov'],
			include: ['src/routes/**', 'src/lib/**', 'src/middleware/**'],
		},
	},
})
