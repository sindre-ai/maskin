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

// Closed allowlist of our own client components, used to tag Sentry events so
// an error can be attributed to a caller (web UI vs MCP vs an agent CLI).
//
// Deliberately NOT the user-agent: that string carries browser and OS version
// details, which are a fingerprinting vector and arguably personal data under
// GDPR. These values name a piece of our software, never a person or device,
// and stay useful for triage — see `sendDefaultPii: false` above, which we keep.
const CLIENT_SOURCES = ['ui', 'mcp', 'agent', 'extension'] as const

export type ClientSourceTag = (typeof CLIENT_SOURCES)[number] | 'other' | 'unknown'

/**
 * Map the caller-supplied `X-Client-Source` header onto a fixed tag value.
 *
 * The header is untrusted free text, so anything unrecognised collapses to
 * `other` rather than being passed through — an unbounded tag would both
 * explode Sentry's tag cardinality and let a caller smuggle arbitrary text
 * (potentially personal data) into our error store.
 */
export function resolveClientSourceTag(header: string | undefined): ClientSourceTag {
	if (!header) return 'unknown'
	const normalized = header.trim().toLowerCase()
	return (CLIENT_SOURCES as readonly string[]).includes(normalized)
		? (normalized as ClientSourceTag)
		: 'other'
}
