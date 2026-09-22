import { defineConfig, devices } from '@playwright/test'
import { E2E_AGENT_SERVER_SECRET } from './src/helpers/api.helper'
import { isArgosEnabled } from './src/helpers/argos.helper'

// Without ARGOS_TOKEN, every upload attempt fails (quota, auth, or a
// missing-token error) — SafeArgosReporter already keeps that from failing
// the run, but there's no point instantiating it (and paying its network
// round-trips) when there's nothing it can successfully do.
const reporters: NonNullable<Parameters<typeof defineConfig>[0]['reporter']> = [['html']]
if (process.env.CI) {
	// Streams each test and each failure to the job log as it happens. The JSON
	// report below is only written at the end of the run, so a shard killed by
	// the job's `timeout-minutes` cap uploads nothing and its failures are
	// otherwise invisible — this is the only record that survives a cancel.
	reporters.push(['line'])
	// Playwright's Multiplexer runs each reporter's onEnd in array order and
	// awaits each before moving to the next — so this JSON report is fully
	// written to disk before SafeArgosReporter's onEnd (below) ever starts.
	// CI reads this file directly (scripts/assert-results.mjs) instead of
	// trusting the process exit code, so a problem inside Argos's reporter
	// can never affect the shard's actual pass/fail signal, regardless of
	// exactly how that problem manifests.
	reporters.push(['json', { outputFile: 'playwright-report/e2e-results.json' }])
}
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
			// The internal log-ingest endpoint (POST
			// /api/internal/agent-servers/sessions/:id/logs) 503s unless the
			// server has AGENT_SERVER_SECRET set — it is the bearer the
			// live-update spec authenticates with. The value must match
			// E2E_AGENT_SERVER_SECRET, which the spec reads. Note this only
			// applies when Playwright spawns the server: with
			// reuseExistingServer (local runs against an already-up dev stack)
			// the server keeps whatever secret it was started with.
			env: { AGENT_SERVER_SECRET: E2E_AGENT_SERVER_SECRET },
		},
		{
			// CI serves the production build (`vite preview`) instead of the dev
			// server. `pnpm build` already runs earlier in the verify-e2e job, so
			// this costs nothing extra — and it fixes a real flake: the dev server
			// transforms every ES module on demand, so a `page.reload()` (a full
			// navigation, not a Vite HMR update) re-fetches and re-transforms the
			// whole module graph from scratch. On a loaded CI runner that
			// regularly pushed reloads on module-heavy routes (settings/keys, with
			// its several Radix-heavy sub-editors) past the wait's 30s budget —
			// see claude-subscription-*.spec.ts's reloadKeysPage — while the API
			// calls behind those same reloads were consistently under 50ms. The
			// production build is pre-bundled static files, so a reload is just a
			// handful of cached-or-not HTTP GETs, not a transform pipeline.
			// `preview.proxy` in apps/web/vite.config.ts mirrors `server.proxy` so
			// /api and /mcp still route to the backend either way.
			command: process.env.CI
				? 'pnpm --filter @maskin/web preview'
				: 'pnpm --filter @maskin/web dev',
			port: 5173,
			reuseExistingServer: !process.env.CI,
			cwd: '../../',
		},
	],
})
