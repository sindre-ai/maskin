import { defineConfig, devices } from '@playwright/test'

// The `@argos-ci/playwright/reporter` runs at the very end of the shard and
// uploads any accumulated screenshots to argos-ci.com. When the workspace's
// Argos plan is out of screenshot quota the reporter's `onEnd()` throws a
// hard `APIError`, which Playwright surfaces as a non-zero exit — failing the
// entire `verify-e2e` step even though the tests themselves passed. To keep
// the merge queue unblocked when quota is exhausted, the reporter is opt-in
// via `ARGOS_UPLOAD=1` in the workflow env. `argosScreenshot()` calls in the
// specs still capture screenshots normally; without the reporter they just
// aren't uploaded.
const ciReporters: [string, Record<string, unknown>?][] = [['html']]
if (process.env.ARGOS_UPLOAD === '1') {
	ciReporters.push(['@argos-ci/playwright/reporter'])
}

export default defineConfig({
	testDir: './src/tests',
	fullyParallel: false,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	reporter: process.env.CI ? ciReporters : [['html']],
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
