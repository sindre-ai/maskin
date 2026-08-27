import {
	ErrorsInstrumentation,
	type Faro,
	SessionInstrumentation,
	ViewInstrumentation,
	WebVitalsInstrumentation,
	initializeFaro,
} from '@grafana/faro-web-sdk'

// Grafana Faro — browser-side observability, reporting into the same Grafana
// Cloud stack as our backend logs and host metrics.
//
// This runs *in parallel with* `./sentry` on purpose: both SDKs report for a
// period so we can compare grouping quality and noise on real traffic before
// deciding whether Grafana can absorb Sentry's frontend role. Retiring
// `@sentry/react` is a separate, evidence-based change — do not assume the
// switch has happened.
//
// Gated exactly as `./sentry` is: a production build (`import.meta.env.PROD`,
// Vite's built-in flag, false under `vite dev`) so cloning this repo and
// running the dev server never reports, plus VITE_FARO_FORCE_ENABLE as the
// one-off escape hatch for verifying the pipeline from a local dev server.
//
// The app key is public by design (like a Sentry DSN) — it ships in the bundle
// and is write-only, scoped to this one Faro app. It is not a secret.

let faro: Faro | null = null

// Must match `appName` in the faro-rollup-plugin config in `vite.config.ts`.
// The plugin stamps a bundle id onto the build under a global keyed by this
// name; the SDK reads it back to match an incoming stack trace to the uploaded
// source map. A mismatch here means uploads succeed and traces stay minified.
export const FARO_APP_NAME = 'maskin-web'

export function initFaro(): void {
	if (faro) return
	const url = import.meta.env.VITE_FARO_URL
	const enabled = import.meta.env.PROD || import.meta.env.VITE_FARO_FORCE_ENABLE === 'true'
	if (!url || !enabled) return
	try {
		faro = initializeFaro({
			url,
			// Grafana Cloud embeds the app key in the collector URL it issues, so
			// this is only set for a self-hosted Alloy collector that wants it as
			// a header. Passing an empty string would send an empty x-api-key.
			...(import.meta.env.VITE_FARO_APP_KEY ? { apiKey: import.meta.env.VITE_FARO_APP_KEY } : {}),
			app: {
				name: FARO_APP_NAME,
				version: import.meta.env.VITE_MASKIN_COMMIT_SHA || 'dev',
				environment: import.meta.env.MODE,
			},
			// Chosen deliberately rather than taking `getWebInstrumentations()`
			// wholesale. What we take:
			//   ErrorsInstrumentation    — uncaught exceptions + unhandled rejections
			//   WebVitalsInstrumentation — Core Web Vitals
			//   ViewInstrumentation      — carries the route name set by setFaroView
			//   SessionInstrumentation   — ties a burst of errors to one visit
			// What we deliberately leave out:
			//   ConsoleInstrumentation  — every console.log becomes a log line, and
			//     we log free-text app data (object titles, chat content) to the
			//     console. That is a PII leak, not just noise.
			//   PerformanceInstrumentation / UserActionInstrumentation — high volume,
			//     nothing we would act on today, and the largest bundle cost.
			//   @grafana/faro-web-tracing (OTel) — not installed. It is the only way
			//     to auto-instrument fetch/XHR, but it costs ~90KB gzipped and needs
			//     backend changes to be useful. We report failed API calls from our
			//     own client chokepoint instead (see reportApiFailure).
			instrumentations: [
				new ErrorsInstrumentation(),
				new WebVitalsInstrumentation(),
				new ViewInstrumentation(),
				new SessionInstrumentation(),
			],
			// Faro reads page.url from location.href on every signal. Our URLs carry
			// free-text query params (e.g. /objects/search?q=<what the user typed>),
			// so strip the query and hash before anything leaves the browser. Ids in
			// the path are fine; free text is not.
			beforeSend: (item) => {
				const page = item.meta?.page
				if (page?.url) page.url = stripQuery(page.url)
				return item
			},
		})
	} catch (err) {
		// Observability must never break the UI, but a broken config should still
		// be discoverable — otherwise a bad collector URL silently kills 100% of
		// frontend visibility with no signal anywhere.
		console.error('[faro] init failed — frontend observability is disabled', err)
	}
}

/** Drops the query string and hash, keeping origin + path. Falls back to the input on a non-URL. */
export function stripQuery(url: string): string {
	try {
		const parsed = new URL(url, globalThis.location?.origin ?? 'http://localhost')
		return `${parsed.origin}${parsed.pathname}`
	} catch {
		return url.split('?')[0].split('#')[0]
	}
}

/**
 * Names the screen an error happened on. TanStack Router route ids are
 * templates (`/_authed/$workspaceId/objects/$objectId`), not resolved paths, so
 * this carries no ids and no free text.
 *
 * `@grafana/faro-react`'s router instrumentation only covers react-router, so
 * this is wired by hand from the router's own subscription in `main.tsx`.
 */
export function setFaroView(routeId: string): void {
	if (!faro) return
	try {
		faro.api.setView({ name: routeId })
	} catch (err) {
		console.error('[faro] setView failed', err)
	}
}

/**
 * Identifies the session by ids only. Deliberately does not set `email`,
 * `username` or `fullName` — see the PII rule in the module header.
 */
export function setFaroUser(actorId: string, workspaceId: string): void {
	if (!faro) return
	try {
		faro.api.setUser({ id: actorId, attributes: { workspace_id: workspaceId } })
	} catch (err) {
		console.error('[faro] setUser failed', err)
	}
}

export function resetFaroUser(): void {
	if (!faro) return
	try {
		faro.api.resetUser()
	} catch (err) {
		console.error('[faro] resetUser failed', err)
	}
}

/**
 * Records a failed `/api` call — the point where a backend problem becomes
 * visible to a user. Sends the method, the path with its query stripped, the
 * status, and the backend's structured error code. No response body, no
 * request body, no query params.
 */
export function reportApiFailure(attrs: {
	method: string
	path: string
	status: number
	code?: string
}): void {
	if (!faro) return
	try {
		faro.api.pushEvent('api_request_failed', {
			method: attrs.method,
			// A relative path, so split rather than parse — stripQuery would
			// resolve it against the origin and report an absolute URL.
			path: attrs.path.split('?')[0].split('#')[0],
			status: String(attrs.status),
			...(attrs.code ? { code: attrs.code } : {}),
		})
	} catch (err) {
		console.error('[faro] reportApiFailure failed', err)
	}
}

export function pushFaroError(error: Error): void {
	if (!faro) return
	try {
		faro.api.pushError(error)
	} catch (err) {
		console.error('[faro] pushError failed', err)
	}
}

// Test-only — lets the faro test suite simulate the post-init state.
export function __setFaroForTesting(value: Faro | null): void {
	faro = value
}
