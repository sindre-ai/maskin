import { defineConfig, devices } from '@playwright/test'
import { isArgosEnabled } from './src/helpers/argos.helper'

// Without ARGOS_TOKEN, every upload attempt fails (quota, auth, or a
// missing-token error) — SafeArgosReporter already keeps that from failing
// the run, but there's no point instantiating it (and paying its network
// round-trips) when there's nothing it can successfully do.
const reporters: NonNullable<Parameters<typeof defineConfig>[0]['reporter']> = [['html']]
if (process.env.CI && isArgosEnabled()) {
	reporters.push(['./src/reporters/safe-argos-reporter.ts'])
}

export default defineConfig({
	testDir: './src/tests',
	fullyParallel: false,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	reporter: reporters,
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
