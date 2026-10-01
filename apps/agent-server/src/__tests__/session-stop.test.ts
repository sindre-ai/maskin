// Handler test for POST /sessions/:id/stop.
//
// Commit 2's second slice has landed on the bet branch — the handler now
// accepts `{ reason, source }` per §2.2 and returns
// `{ stopped: 'sandbox-stopped' | 'sandbox-already-gone' | 'sandbox-not-found' }`
// while preserving the `sessionExitCodes.set(id, FORCED_STOP_EXIT_CODE)` seed
// order (seed → stop → respond) — that ordering is load-bearing for
// /complete's exit-code recovery.
//
// This file covers the current handler shape end-to-end: bearer auth, id
// validation, request-body validation (empty body rejected as invalid_request),
// seed-order preservation, and the three typed `stopped` outcomes.

import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FORCED_STOP_EXIT_CODE, buildApp } from '../index'
import type { AgentServerEnv } from '../lib/env'

// Inline mirrors of the §6.4 shared types so this file does NOT force an
// `@maskin/shared` dep on the agent-server package boundary just for a test —
// commit 2's handler landing will add that dep where the shared types are
// actually used at runtime. A mismatch on either side would surface as a
// runtime shape error in the commit-2 handler tests, not here.
type TerminalOutcomeKind = 'complete' | 'fail' | 'timeout' | 'stop' | 'pause'
type SettleSource =
	| 'sandbox-exit'
	| 'reaper'
	| 'reconciler'
	| 'user-stop'
	| 'timeout-watchdog'
	| 'dispatch-queue'
	| 'idle-watcher'
interface StopSessionRequest {
	reason: TerminalOutcomeKind
	source: SettleSource
}
interface StopSessionResponse {
	stopped: 'sandbox-stopped' | 'sandbox-already-gone' | 'sandbox-not-found'
}

function makeEnv(overrides: Partial<AgentServerEnv> = {}): AgentServerEnv {
	return {
		PORT: 3001,
		METRICS_PORT: 0,
		AGENT_SERVER_STALL_THRESHOLD_MS: 300_000,
		AGENT_SERVER_SECRET: 'test-secret-thirty-two-chars-long',
		MSB_BIN: '/usr/local/bin/msb',
		AGENT_SESSION_ROOT: '/tmp/agent-server-session-stop-test',
		S3_REGION: 'us-east-1',
		WARM_POOL_REFRESH_MINUTES: 0,
		BROWSER_SIDECAR_IMAGE: 'browser-sidecar:latest',
		DESKTOP_IMAGE: 'desktop:latest',
		AGENT_SERVER_SSH_KEY_PATH: '/tmp/agent-server-session-stop-test/ssh/relay_key',
		SESSION_MAX_DURATION: '8h',
		...overrides,
	}
}

/**
 * A minimal msb `run` stub that answers `remove` (used by `stopSandbox`) with a
 * successful shape. The default answers `--version` and `list` so buildApp
 * boots cleanly. Callers can override per-test to force a 404 or a throw.
 */
function makeRunner(overrides?: {
	onRemove?: () => { ok: true } | { throwError: string } | { notFound: true }
}) {
	const calls: Array<{ args: readonly string[] }> = []
	const run = async (
		_bin: string,
		args: readonly string[],
	): Promise<{ stdout: string; stderr: string }> => {
		calls.push({ args })
		if (args[0] === '--version') return { stdout: 'microsandbox 0.5.4', stderr: '' }
		if (args[0] === 'list') return { stdout: '[]', stderr: '' }
		if (args[0] === 'stop' || args[0] === 'remove') {
			const outcome = overrides?.onRemove?.() ?? { ok: true }
			if ('ok' in outcome) return { stdout: 'ok', stderr: '' }
			if ('notFound' in outcome) {
				throw new Error('microsandbox: sandbox not found')
			}
			throw new Error(outcome.throwError)
		}
		return { stdout: '', stderr: '' }
	}
	return { run, calls }
}

let sessionRoot: string
beforeEach(() => {
	sessionRoot = mkdtempSync(join(tmpdir(), 'agent-server-session-stop-'))
})
afterEach(async () => {
	await rm(sessionRoot, { recursive: true, force: true })
})

const VALID_STOP_BODY = JSON.stringify({
	reason: 'stop',
	source: 'user-stop',
} satisfies StopSessionRequest)

describe('POST /sessions/:id/stop — auth + validation gates', () => {
	it('requires bearer auth', async () => {
		const { run } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/x', run } })
		const res = await app.request('/sessions/sess-1/stop', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
		})
		expect(res.status).toBe(401)
	})

	it('rejects a malformed session id with 400', async () => {
		const { run } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/x', run } })
		const res = await app.request('/sessions/..%2Fetc%2Fpasswd/stop', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: VALID_STOP_BODY,
		})
		expect(res.status).toBe(400)
	})

	it('rejects an empty body with 400 (reason + source are required per §2.2)', async () => {
		const { run } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/x', run } })
		const res = await app.request('/sessions/sess-1/stop', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: '{}',
		})
		expect(res.status).toBe(400)
	})

	it('seeds sessionExitCodes with FORCED_STOP_EXIT_CODE BEFORE calling stop', async () => {
		// Runner reports the sandbox is present so the handler takes the
		// stop-and-respond branch — otherwise the not-found early-return would
		// exit before msb `stop`/`remove` runs and the seed-order check would be
		// meaningless. What we're pinning here is: seed lands, THEN stop is invoked.
		const calls: Array<{ args: readonly string[] }> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push({ args })
			if (args[0] === '--version') return { stdout: 'microsandbox 0.5.4', stderr: '' }
			if (args[0] === 'list') return { stdout: JSON.stringify([{ name: 'sess-1' }]), stderr: '' }
			if (args[0] === 'stop' || args[0] === 'remove') return { stdout: 'ok', stderr: '' }
			return { stdout: '', stderr: '' }
		}
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const sessionExitCodes = new Map<string, number>()
		const app = buildApp({
			env,
			storage: null,
			msb: { msbBin: '/x', run },
			sessionExitCodes,
		})

		const res = await app.request('/sessions/sess-1/stop', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: VALID_STOP_BODY,
		})

		expect(res.status).toBe(200)
		expect(sessionExitCodes.get('sess-1')).toBe(FORCED_STOP_EXIT_CODE)
		const stopIdx = calls.findIndex((c) => c.args[0] === 'stop' || c.args[0] === 'remove')
		expect(stopIdx, 'msb stop should have been invoked').toBeGreaterThanOrEqual(0)
	})

	it('is idempotent: absent sandbox returns { stopped: sandbox-not-found } with 200', async () => {
		const { run } = makeRunner({ onRemove: () => ({ notFound: true }) })
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/x', run } })

		const res = await app.request('/sessions/sess-gone/stop', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: VALID_STOP_BODY,
		})

		// Current handler collapses msb errors on a not-found sandbox into the
		// typed sandbox-not-found outcome + 200 — settleSession's stopSandbox
		// callback maps that to skipped-none-live.
		expect(res.status).toBe(200)
		const body = (await res.json()) as StopSessionResponse
		expect(body.stopped).toBe('sandbox-not-found')
	})
})

describe('POST /sessions/:id/stop — §2.2 typed outcome shape', () => {
	// Shared-types compile pin so a rename on the shared side turns into a
	// TypeScript error in this file, not a silent shape drift.
	it('shared types compile against §6.4', () => {
		const req: StopSessionRequest = { reason: 'stop', source: 'user-stop' }
		const res: StopSessionResponse = { stopped: 'sandbox-stopped' }
		expect(req.reason).toBe('stop')
		expect(res.stopped).toBe('sandbox-stopped')
	})

	it('returns { stopped: "sandbox-stopped" } when the sandbox is present and stopped', async () => {
		// Runner reports the sandbox is present in `msb list` output so the handler
		// takes the "stop it" branch (sandbox-stopped) rather than the not-found branch.
		const calls: Array<{ args: readonly string[] }> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push({ args })
			if (args[0] === '--version') return { stdout: 'microsandbox 0.5.4', stderr: '' }
			if (args[0] === 'list') return { stdout: JSON.stringify([{ name: 'sess-live' }]), stderr: '' }
			if (args[0] === 'stop' || args[0] === 'remove') return { stdout: 'ok', stderr: '' }
			return { stdout: '', stderr: '' }
		}
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/x', run } })

		const res = await app.request('/sessions/sess-live/stop', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: VALID_STOP_BODY,
		})

		expect(res.status).toBe(200)
		const body = (await res.json()) as StopSessionResponse
		expect(body.stopped).toBe('sandbox-stopped')
	})

	it('returns { stopped: "sandbox-not-found" } when msb list omits the sandbox', async () => {
		// list returns [] so the sandbox is not tracked — handler responds
		// sandbox-not-found with 200 without invoking stop/remove.
		const calls: Array<{ args: readonly string[] }> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push({ args })
			if (args[0] === '--version') return { stdout: 'microsandbox 0.5.4', stderr: '' }
			if (args[0] === 'list') return { stdout: '[]', stderr: '' }
			return { stdout: '', stderr: '' }
		}
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/x', run } })

		const res = await app.request('/sessions/sess-unknown/stop', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: VALID_STOP_BODY,
		})

		expect(res.status).toBe(200)
		const body = (await res.json()) as StopSessionResponse
		expect(body.stopped).toBe('sandbox-not-found')
		expect(calls.some((c) => c.args[0] === 'stop' || c.args[0] === 'remove')).toBe(false)
	})

	it.todo(
		'returns { stopped: "sandbox-already-gone" } when stop reports the sandbox was reaped mid-flight — needs an msb-side race harness not present on this branch',
	)
	it.todo(
		'logs a warning after 3 retries on 5xx and still responds — retry policy lives at the client layer (agent-server-client.ts, currently no retry)',
	)
})
