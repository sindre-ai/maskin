// Emits the `install_started` PostHog event and persists the state
// (anonymous_id + started_at) that the backend later reads to fire
// `install_completed` and `workspace_first_ready`. Kept as a stand-alone
// .mjs so `dev.sh` / `dev.mjs` / `dev-no-docker.sh` can invoke it before
// `pnpm install` runs and before the backend exists on disk — no imports
// from `apps/dev` or `packages/*`.
//
// CLI usage:
//   node scripts/lib/install-telemetry.mjs start <install_method>
// where install_method is one of: docker | no-docker
//
// Contract: never throws, never blocks the caller. Silent when
// MASKIN_TELEMETRY_DISABLED=1 or CI=* is set, or when POSTHOG_API_KEY is
// missing (i.e. local contributor with no analytics wiring — same
// behaviour as apps/dev/src/lib/analytics/posthog.ts).

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com'
const CAPTURE_TIMEOUT_MS = 2_000
const ALLOWED_METHODS = new Set(['docker', 'no-docker'])

function stateFilePath() {
	const override = process.env.MASKIN_TELEMETRY_STATE_PATH?.trim()
	if (override) return override
	return join(homedir(), '.maskin', 'install-telemetry.json')
}

function telemetryDisabled() {
	if (process.env.MASKIN_TELEMETRY_DISABLED === '1') return true
	if (process.env.MASKIN_TELEMETRY_DISABLED === 'true') return true
	if (process.env.CI) return true
	return false
}

export function readState() {
	try {
		const raw = readFileSync(stateFilePath(), 'utf-8')
		const parsed = JSON.parse(raw)
		if (parsed && typeof parsed === 'object') {
			const anonymous_id = typeof parsed.anonymous_id === 'string' ? parsed.anonymous_id : null
			const install_started_at =
				typeof parsed.install_started_at === 'string' ? parsed.install_started_at : null
			const install_method =
				typeof parsed.install_method === 'string' ? parsed.install_method : null
			if (anonymous_id) return { anonymous_id, install_started_at, install_method }
		}
	} catch {
		// missing / malformed state — treat as first run
	}
	return null
}

function writeState(state) {
	const path = stateFilePath()
	try {
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
	} catch {
		// Best-effort: if we can't persist the state, install_completed and
		// workspace_first_ready simply won't fire. Never block install.
	}
}

export function ensureAnonymousId(existing) {
	if (existing?.anonymous_id) return existing.anonymous_id
	return randomUUID()
}

async function postToPosthog(event, distinctId, properties) {
	const apiKey = process.env.POSTHOG_API_KEY?.trim()
	if (!apiKey) return
	const host = (process.env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST).replace(/\/$/, '')
	const body = {
		api_key: apiKey,
		event,
		distinct_id: distinctId,
		properties,
		timestamp: new Date().toISOString(),
	}
	try {
		await fetch(`${host}/i/v0/e/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
		})
	} catch {
		// Silent — the whole point of this file is to never break `pnpm dev`.
	}
}

export async function emitInstallStarted(installMethodArg) {
	if (telemetryDisabled()) return null
	const install_method = ALLOWED_METHODS.has(installMethodArg) ? installMethodArg : 'unknown'
	const os = platform()
	const now = new Date().toISOString()

	// Re-use the anonymous_id across restarts so `workspace_first_ready` for
	// a returning user still joins to their original `install_started`.
	// Refresh `install_started_at` on every run so the TTV clock resets each
	// time the user re-runs the single-command install — a fresh clone or a
	// re-run after a failed setup is still a legitimate install attempt.
	const existing = readState()
	const anonymous_id = ensureAnonymousId(existing)
	const state = { anonymous_id, install_started_at: now, install_method }
	writeState(state)

	await postToPosthog('install_started', anonymous_id, {
		install_method,
		os,
		anonymous_id,
	})
	return state
}

async function main() {
	const [, , command, methodArg] = process.argv
	if (command !== 'start') {
		// Silent unknown-command: this script is called from install scripts
		// and must never emit noise to stderr.
		return
	}
	await emitInstallStarted(methodArg)
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly = (() => {
	try {
		const entry = process.argv[1]
		if (!entry) return false
		const url = new URL(import.meta.url).pathname
		return entry === url || entry.endsWith('/install-telemetry.mjs')
	} catch {
		return false
	}
})()

if (invokedDirectly) {
	main().catch(() => {
		// Absolute belt-and-braces: never propagate errors to the parent
		// shell — `set -e` in dev.sh would kill the whole install.
	})
}
