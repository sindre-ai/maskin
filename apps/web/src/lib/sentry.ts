import * as Sentry from '@sentry/react'

let initialized = false

// Gated to a production build (import.meta.env.PROD, Vite's built-in flag — false
// under `vite dev`) so cloning this repo and running the dev server never reports
// to Sentry, even if a DSN ends up in a local .env. VITE_SENTRY_FORCE_ENABLE is a
// one-off escape hatch for verifying the pipeline from a local dev server.
export function initSentry(): void {
	if (initialized) return
	const dsn = import.meta.env.VITE_SENTRY_DSN
	const enabled = import.meta.env.PROD || import.meta.env.VITE_SENTRY_FORCE_ENABLE === 'true'
	if (!dsn || !enabled) return
	try {
		Sentry.init({
			dsn,
			environment: import.meta.env.MODE,
			sendDefaultPii: false,
		})
		initialized = true
	} catch {
		// Error reporting must never break the UI.
	}
}

export function captureException(error: unknown): void {
	if (!initialized) return
	try {
		Sentry.captureException(error)
	} catch {
		// Error reporting must never break the UI.
	}
}
