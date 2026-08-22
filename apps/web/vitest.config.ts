import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		environment: 'jsdom',
		setupFiles: ['src/__tests__/setup.ts'],
		include: ['src/__tests__/**/*.test.{ts,tsx}'],
		testTimeout: 15000,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov'],
			exclude: ['src/components/ui/**'],
			thresholds: {
				lines: 60,
				branches: 60,
				functions: 60,
				statements: 60,
			},
		},
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
			// Resolve module-sdk to its SOURCE, not its build output.
			//
			// `packages/module-sdk/package.json` maps `exports["."].types` to
			// `./src/index.ts` but `exports["."].default` to `./dist/index.js`. Without
			// this alias `tsc` reads fresh source while Vitest resolves whatever was
			// last built, so a test exercising real module-sdk behaviour passes or
			// fails for reasons unrelated to the change under test until someone
			// remembers `pnpm --filter @maskin/module-sdk build`. Several tests here
			// use the registry for real (`create-picker`, `extensions-manager`,
			// `use-available-object-types`), and a `vi.mock(..., importOriginal)`
			// wrapper would not help — it reaches through to `dist/` too.
			//
			// See the "Verifying Against Stale State" entry in
			// `.claude/rules/known-pitfalls.md`.
			'@maskin/module-sdk': path.resolve(__dirname, '../../packages/module-sdk/src/index.ts'),
		},
	},
})
