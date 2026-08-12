import * as Sentry from '@sentry/node'

// Imported first (before any route/service modules) so the client exists
// before anything can log an error. No-ops safely when the DSN is unset —
// Sentry.captureException/captureMessage are safe to call on an
// uninitialized client, they just do nothing.
//
// Gated to NODE_ENV=production (same convention as file-urls.ts/dev-bootstrap.ts)
// so cloning this repo and running `pnpm dev` never reports to Sentry, even if a
// DSN ends up in a local .env. SENTRY_FORCE_ENABLE is a one-off escape hatch for
// verifying the pipeline from a local box without flipping NODE_ENV (which also
// gates unrelated prod-only behavior elsewhere in this app).
const dsn = process.env.SENTRY_DSN_DEV
const enabled = process.env.NODE_ENV === 'production' || process.env.SENTRY_FORCE_ENABLE === 'true'
if (dsn && enabled) {
	// Guarded — this runs at module-import time, before the HTTP listener
	// exists, so an uncaught throw here would crash the process on boot.
	try {
		Sentry.init({
			dsn,
			environment: process.env.NODE_ENV ?? 'development',
			tracesSampleRate: 0.1,
			sendDefaultPii: false,
		})
	} catch (err) {
		console.error('[sentry] init failed — error reporting is disabled', err)
	}
}

export { Sentry }
