// Covers the state-file contract written by scripts/lib/install-telemetry.mjs
// — the file the backend `readInstallTelemetryState()` reads to fire
// install_completed / workspace_first_ready. If the script's schema drifts
// from the backend reader, this test fails.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readInstallTelemetryState } from '../../../lib/analytics/install-telemetry'

const SCRIPT_PATH = resolve(__dirname, '../../../../../../scripts/lib/install-telemetry.mjs')

let tempDir: string
let statePath: string
const originalEnv = { ...process.env }

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'maskin-install-telemetry-script-'))
	statePath = join(tempDir, 'install-telemetry.json')
	process.env = { ...originalEnv }
	// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
	delete process.env.CI
	// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
	delete process.env.MASKIN_TELEMETRY_DISABLED
	// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
	delete process.env.POSTHOG_API_KEY
	process.env.MASKIN_TELEMETRY_STATE_PATH = statePath
})

afterEach(() => {
	process.env = { ...originalEnv }
	rmSync(tempDir, { recursive: true, force: true })
})

describe('scripts/lib/install-telemetry.mjs', () => {
	it('writes a state file readable by the backend reader', async () => {
		const mod = await import(SCRIPT_PATH)
		const state = await mod.emitInstallStarted('docker')

		expect(existsSync(statePath)).toBe(true)
		expect(state).not.toBeNull()
		expect(state.install_method).toBe('docker')
		expect(typeof state.anonymous_id).toBe('string')
		expect(state.anonymous_id.length).toBeGreaterThan(0)
		expect(typeof state.install_started_at).toBe('string')

		const readBack = readInstallTelemetryState()
		expect(readBack).toEqual(state)
	})

	it('normalises an unknown install method to "unknown"', async () => {
		const mod = await import(SCRIPT_PATH)
		const state = await mod.emitInstallStarted('brew-cask')
		expect(state?.install_method).toBe('unknown')
	})

	it('preserves the anonymous_id across restarts (returning user)', async () => {
		const mod = await import(SCRIPT_PATH)
		const first = await mod.emitInstallStarted('docker')
		// Small delay so install_started_at moves forward — the two calls
		// otherwise land in the same millisecond and the ISO strings compare
		// equal, hiding the refresh semantics we're asserting.
		await new Promise((r) => setTimeout(r, 5))
		const second = await mod.emitInstallStarted('no-docker')
		expect(first?.anonymous_id).toBe(second?.anonymous_id)
		// install_started_at is refreshed on each run so TTV measures the
		// most recent install attempt (a re-run after a failed setup still
		// counts as its own install session).
		expect(Date.parse(second?.install_started_at ?? '')).toBeGreaterThanOrEqual(
			Date.parse(first?.install_started_at ?? ''),
		)
		expect(second?.install_method).toBe('no-docker')
	})

	it('is a no-op when MASKIN_TELEMETRY_DISABLED=1', async () => {
		process.env.MASKIN_TELEMETRY_DISABLED = '1'
		const mod = await import(SCRIPT_PATH)
		const state = await mod.emitInstallStarted('docker')
		expect(state).toBeNull()
		expect(existsSync(statePath)).toBe(false)
	})

	it('is a no-op in CI', async () => {
		process.env.CI = 'true'
		const mod = await import(SCRIPT_PATH)
		const state = await mod.emitInstallStarted('docker')
		expect(state).toBeNull()
		expect(existsSync(statePath)).toBe(false)
	})
})
