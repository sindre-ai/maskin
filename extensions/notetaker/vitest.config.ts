import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		include: ['server/__tests__/**/*.test.ts'],
	},
})
