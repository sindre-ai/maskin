import * as Sentry from '@sentry/node'

// Imported first (before any route/service modules) so the client exists
// before anything can log an error. No-ops safely when the DSN is unset —
// Sentry.captureException/captureMessage are safe to call on an
// uninitialized client, they just do nothing.
//
// Gated to NODE_ENV=production (already set in systemd/maskin-agent-server.service
// for the real host) so a local `pnpm dev` run never reports to Sentry, even if a
// DSN ends up in a local .env. SENTRY_FORCE_ENABLE is a one-off escape hatch for
// verifying the pipeline from a local box without setting NODE_ENV=production.
const dsn = process.env.SENTRY_DSN_AGENT_SERVER
const enabled = process.env.NODE_ENV === 'production' || process.env.SENTRY_FORCE_ENABLE === 'true'
if (dsn && enabled) {
	Sentry.init({
		dsn,
		environment: process.env.NODE_ENV ?? 'development',
		tracesSampleRate: 0.1,
		sendDefaultPii: false,
	})
}

export { Sentry }
