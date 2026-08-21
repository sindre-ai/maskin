import { defineConfig, devices } from '@playwright/test'

// Default target is the locally-booted stack. `PLAYWRIGHT_BASE_URL` repoints the
// suite at a deployed environment for the post-deploy smoke run.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173'

// A remote target must not have a local dev stack booted for it, and must not
// upload visual snapshots. Loopback URLs stay "local" so an explicit
// PLAYWRIGHT_BASE_URL=http://localhost:5173 behaves exactly as today.
const isRemote =
	/^https?:\/\//.test(baseURL) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseURL)

const localWebServer = [
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
]

export default defineConfig({
	testDir: './src/tests',
	// The smoke run is a short, independent subset, so it can parallelise. The
	// full local/CI suite stays serial as before.
	fullyParallel: isRemote,
	retries: process.env.CI ? 2 : 0,
	workers: isRemote ? 4 : 1,
	globalSetup: './src/global-setup.ts',
	globalTeardown: './src/global-teardown.ts',
	reporter:
		process.env.CI && !isRemote
			? [['html'], ['./src/reporters/safe-argos-reporter.ts']]
			: process.env.CI
				? [['html'], ['list']]
				: [['html']],
	use: {
		baseURL,
		trace: 'on-first-retry',
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
	...(isRemote ? {} : { webServer: localWebServer }),
})
