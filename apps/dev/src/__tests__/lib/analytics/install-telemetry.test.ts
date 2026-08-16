import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	__resetInstallTelemetryForTesting,
	emitInstallCompleted,
	emitWorkspaceFirstReady,
	readInstallTelemetryState,
} from '../../../lib/analytics/install-telemetry'

let tempDir: string
let statePath: string
const originalEnv = { ...process.env }

function writeState(state: unknown) {
	writeFileSync(statePath, JSON.stringify(state), 'utf-8')
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'maskin-install-telemetry-'))
	statePath = join(tempDir, 'install-telemetry.json')
	process.env = { ...originalEnv }
	// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
	delete process.env.CI
	// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
	delete process.env.MASKIN_TELEMETRY_DISABLED
	process.env.MASKIN_TELEMETRY_STATE_PATH = statePath
	capturePosthogEventMock.mockClear()
	__resetInstallTelemetryForTesting()
})

afterEach(() => {
	process.env = { ...originalEnv }
	rmSync(tempDir, { recursive: true, force: true })
})

describe('readInstallTelemetryState', () => {
	it('returns null when the state file is missing', () => {
		expect(readInstallTelemetryState()).toBeNull()
	})

	it('returns null when the state file is malformed', () => {
		writeFileSync(statePath, 'not json', 'utf-8')
		expect(readInstallTelemetryState()).toBeNull()
	})

	it('returns null when anonymous_id is missing (required for distinct_id)', () => {
		writeState({ install_started_at: new Date().toISOString() })
		expect(readInstallTelemetryState()).toBeNull()
	})

	it('parses a well-formed state file', () => {
		const now = new Date().toISOString()
		writeState({ anonymous_id: 'anon-1', install_started_at: now, install_method: 'docker' })
		expect(readInstallTelemetryState()).toEqual({
			anonymous_id: 'anon-1',
			install_started_at: now,
			install_method: 'docker',
		})
	})
})

describe('emitInstallCompleted', () => {
	it('captures install_completed with duration_seconds derived from state', async () => {
		const startedAt = new Date(Date.now() - 42_000).toISOString()
		writeState({ anonymous_id: 'anon-1', install_started_at: startedAt, install_method: 'docker' })

		await emitInstallCompleted()

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
		const [event, distinctId, props] = capturePosthogEventMock.mock.calls[0] ?? []
		expect(event).toBe('install_completed')
		expect(distinctId).toBe('anon-1')
		expect(props).toMatchObject({
			install_method: 'docker',
			anonymous_id: 'anon-1',
		})
		expect(typeof (props as Record<string, unknown>).os).toBe('string')
		const duration = (props as Record<string, unknown>).duration_seconds as number
		expect(duration).toBeGreaterThanOrEqual(40)
		expect(duration).toBeLessThan(120)
	})

	it('skips when the state file is missing (server booted without install script)', async () => {
		await emitInstallCompleted()
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('is idempotent within a single process life', async () => {
		writeState({
			anonymous_id: 'anon-1',
			install_started_at: new Date().toISOString(),
			install_method: 'docker',
		})
		await emitInstallCompleted()
		await emitInstallCompleted()
		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
	})

	it('respects MASKIN_TELEMETRY_DISABLED', async () => {
		process.env.MASKIN_TELEMETRY_DISABLED = '1'
		writeState({
			anonymous_id: 'anon-1',
			install_started_at: new Date().toISOString(),
			install_method: 'docker',
		})
		await emitInstallCompleted()
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('respects CI env var', async () => {
		process.env.CI = 'true'
		writeState({
			anonymous_id: 'anon-1',
			install_started_at: new Date().toISOString(),
			install_method: 'docker',
		})
		await emitInstallCompleted()
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('sends null duration_seconds when install_started_at is missing', async () => {
		writeState({ anonymous_id: 'anon-1', install_started_at: null, install_method: 'docker' })
		await emitInstallCompleted()
		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
		const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(props.duration_seconds).toBeNull()
	})
})

describe('emitWorkspaceFirstReady', () => {
	it('captures workspace_first_ready keyed on anonymous_id with seconds_since_install_started', async () => {
		const startedAt = new Date(Date.now() - 10_000).toISOString()
		writeState({ anonymous_id: 'anon-1', install_started_at: startedAt, install_method: 'docker' })

		await emitWorkspaceFirstReady({ workspaceId: 'ws-1', actorId: 'actor-1' })

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
		const [event, distinctId, props] = capturePosthogEventMock.mock.calls[0] ?? []
		expect(event).toBe('workspace_first_ready')
		expect(distinctId).toBe('anon-1')
		expect(props).toMatchObject({ workspace_id: 'ws-1', actor_id: 'actor-1' })
		const secs = (props as Record<string, unknown>).seconds_since_install_started as number
		expect(secs).toBeGreaterThanOrEqual(9)
		expect(secs).toBeLessThan(90)
	})

	it('skips when the state file is missing', async () => {
		await emitWorkspaceFirstReady({ workspaceId: 'ws-1', actorId: 'actor-1' })
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('is idempotent within a single process life', async () => {
		writeState({
			anonymous_id: 'anon-1',
			install_started_at: new Date().toISOString(),
			install_method: 'docker',
		})
		await emitWorkspaceFirstReady({ workspaceId: 'ws-1', actorId: 'actor-1' })
		await emitWorkspaceFirstReady({ workspaceId: 'ws-2', actorId: 'actor-2' })
		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
	})

	it('respects MASKIN_TELEMETRY_DISABLED', async () => {
		process.env.MASKIN_TELEMETRY_DISABLED = 'true'
		writeState({
			anonymous_id: 'anon-1',
			install_started_at: new Date().toISOString(),
			install_method: 'docker',
		})
		await emitWorkspaceFirstReady({ workspaceId: 'ws-1', actorId: 'actor-1' })
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})
})
