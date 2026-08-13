import { defineConfig } from 'vitest/config'

export default defineConfig({
	esbuild: {
		jsx: 'automatic',
	},
	test: {
		globals: true,
		include: ['src/__tests__/**/*.test.ts'],
	},
})
