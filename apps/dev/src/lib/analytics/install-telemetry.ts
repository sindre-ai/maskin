import { readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

// Reads the state file written by `scripts/lib/install-telemetry.mjs` and
// fires the two backend-side TTV events:
//   - install_completed (once, when the API is reachable on localhost)
//   - workspace_first_ready (once, when the auto-bootstrap actually creates
//     the first workspace for a fresh install)
//
// The file is optional: if the user started the server without going through
// `pnpm dev` / `pnpm dev:no-docker` (e.g. `pnpm --filter @maskin/dev dev`
// directly, or a CI job), we simply skip — TTV is only meaningful when
// `install_started` was emitted at the same install session.

interface InstallTelemetryState {
	anonymous_id: string
	install_started_at: string | null
	install_method: string | null
}

function stateFilePath(): string {
	const override = process.env.MASKIN_TELEMETRY_STATE_PATH?.trim()
	if (override) return override
	return join(homedir(), '.maskin', 'install-telemetry.json')
}

function telemetryDisabled(): boolean {
	if (process.env.MASKIN_TELEMETRY_DISABLED === '1') return true
	if (process.env.MASKIN_TELEMETRY_DISABLED === 'true') return true
	if (process.env.CI) return true
	return false
}

export function readInstallTelemetryState(): InstallTelemetryState | null {
	try {
		const raw = readFileSync(stateFilePath(), 'utf-8')
		const parsed = JSON.parse(raw) as unknown
		if (!parsed || typeof parsed !== 'object') return null
		const p = parsed as Record<string, unknown>
		const anonymous_id = typeof p.anonymous_id === 'string' ? p.anonymous_id : null
		if (!anonymous_id) return null
		const install_started_at =
			typeof p.install_started_at === 'string' ? p.install_started_at : null
		const install_method = typeof p.install_method === 'string' ? p.install_method : null
		return { anonymous_id, install_started_at, install_method }
	} catch {
		return null
	}
}

function secondsSince(iso: string | null): number | null {
	if (!iso) return null
	const started = Date.parse(iso)
	if (!Number.isFinite(started)) return null
	const diff = (Date.now() - started) / 1000
	if (!Number.isFinite(diff) || diff < 0) return null
	return Math.round(diff * 1000) / 1000
}

// Module-level once-guards. The server calls `emitInstallCompleted()` from
// the serve() ready callback (single invocation), but the workspace-first-
// ready path runs inside `maybeBootstrapDev()` which is called on every
// boot — the once-guard prevents duplicate emits inside a single process
// life if bootstrap ever gets called twice.
let installCompletedEmitted = false
let workspaceFirstReadyEmitted = false

export async function emitInstallCompleted(): Promise<void> {
	if (telemetryDisabled()) return
	if (installCompletedEmitted) return
	installCompletedEmitted = true

	const state = readInstallTelemetryState()
	if (!state) {
		logger.debug('install_completed skipped — no install-telemetry state on disk')
		return
	}
	const duration_seconds = secondsSince(state.install_started_at)
	await capturePosthogEvent('install_completed', state.anonymous_id, {
		install_method: state.install_method,
		os: platform(),
		anonymous_id: state.anonymous_id,
		duration_seconds,
	})
}

interface WorkspaceFirstReadyProps {
	workspaceId: string
	actorId: string
}

export async function emitWorkspaceFirstReady(p: WorkspaceFirstReadyProps): Promise<void> {
	if (telemetryDisabled()) return
	if (workspaceFirstReadyEmitted) return
	workspaceFirstReadyEmitted = true

	const state = readInstallTelemetryState()
	if (!state) {
		logger.debug('workspace_first_ready skipped — no install-telemetry state on disk')
		return
	}
	const seconds_since_install_started = secondsSince(state.install_started_at)
	// Anchor distinct_id to the install session so the TTV query
	// (`countIf(seconds_since_install_started < 180)`) can pair the two
	// events on the same user. workspace_id / actor_id ride as properties.
	await capturePosthogEvent('workspace_first_ready', state.anonymous_id, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		seconds_since_install_started,
	})
}

// Test-only helper — the module-level once-guards would otherwise leak
// between test cases in the same suite.
export function __resetInstallTelemetryForTesting(): void {
	installCompletedEmitted = false
	workspaceFirstReadyEmitted = false
}
