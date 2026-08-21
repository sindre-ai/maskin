import { defineConfig, devices } from '@playwright/test'
import type { ReporterDescription } from '@playwright/test'
import { isArgosEnabled } from './src/helpers/argos.helper'

// Argos is an optional visual-regression add-on, never a gate: its upload can
// fail on quota or an outage regardless of whether the tests passed. Only
// register the reporter where Argos is explicitly switched on.
const argosReporter: ReporterDescription[] = isArgosEnabled()
	? [['./src/reporters/safe-argos-reporter.ts']]
	: []

export default defineConfig({
	testDir: './src/tests',
	fullyParallel: false,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	reporter: [['html'], ...argosReporter],
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
