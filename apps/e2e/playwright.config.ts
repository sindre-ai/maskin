import { defineConfig, devices } from '@playwright/test'

// Argos is opt-in via ARGOS_UPLOAD=1. Its reporter's onEnd throws on upload
// failure (e.g. free-plan screenshot cap hit), which propagates as exit code 1
// and fails every shard regardless of the tests' own outcomes. Flip
// ARGOS_UPLOAD=1 in the workflow env once the plan can accept new screenshots.
const argosEnabled = process.env.CI && process.env.ARGOS_UPLOAD === '1'

export default defineConfig({
	testDir: './src/tests',
	fullyParallel: false,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	reporter: argosEnabled ? [['html'], ['@argos-ci/playwright/reporter']] : [['html']],
	use: {
		baseURL: 'http://localhost:5173',
		trace: 'on-first-retry',
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
	webServer: [
		{
			command: 'pnpm --filter @maskin/dev dev',
			port: 3000,
			reuseExistingServer: !process.env.CI,
			cwd: '../../',
		},
		{
			command: 'pnpm --filter @maskin/web dev',
			port: 5173,
			reuseExistingServer: !process.env.CI,
			cwd: '../../',
		},
	],
})
