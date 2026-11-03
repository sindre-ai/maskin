import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StorageProvider } from '@maskin/storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	FORCED_STOP_EXIT_CODE,
	SESSION_EXIT_CODE_SENTINEL_TTL_MS,
	buildApp,
	reconcileOnBoot,
} from '../index'
import type { AgentServerEnv } from '../lib/env'
import { logger } from '../lib/logger'
import { StallTracker } from '../lib/stall-tracker'
import { ImageWarmer } from '../services/image-warmer'

function makeEnv(overrides: Partial<AgentServerEnv> = {}): AgentServerEnv {
	return {
		PORT: 3001,
		METRICS_PORT: 0,
		AGENT_SERVER_STALL_THRESHOLD_MS: 300_000,
		AGENT_SERVER_SECRET: 'test-secret-thirty-two-chars-long',
		MSB_BIN: '/usr/local/bin/msb',
		AGENT_SESSION_ROOT: '/tmp/agent-server-test',
		S3_REGION: 'us-east-1',
		WARM_POOL_REFRESH_MINUTES: 0,
		DESKTOP_IMAGE: 'desktop:latest',
		AGENT_SERVER_SSH_KEY_PATH: '/tmp/agent-server-test/ssh/relay_key',
		DESKTOP_RELAY_PORT_START: 20000,
		DESKTOP_RELAY_PORT_END: 21999,
		DESKTOP_RELAY_BLOCK_SIZE: 8,
		DESKTOP_SNAPSHOTS: false,
		DESKTOP_IDLE_MINUTES: 10,
		SESSION_MAX_DURATION: '8h',
		...overrides,
	}
}

function makeRunner(opts: { existingSandboxes?: string[] } = {}) {
	const calls: Array<{ args: readonly string[] }> = []
	const existing = new Set(opts.existingSandboxes ?? [])
	const run = async (
		_bin: string,
		args: readonly string[],
	): Promise<{ stdout: string; stderr: string }> => {
		calls.push({ args })
		if (args[0] === '--version') return { stdout: 'microsandbox 0.5.4', stderr: '' }
		if (args[0] === 'list') {
			// A live sandbox appears in `list` after either an explicit
			// `existingSandboxes` seed (stop tests can name the id they want
			// to look present) or after a `create` command earlier in the
			// same run. `stopSandbox` matches on name via listSandboxNames,
			// so tests must be able to make a specific id look present.
			const created = calls
				.map((c) => (c.args[0] === 'create' ? c.args[c.args.indexOf('--name') + 1] : null))
				.filter((x): x is string => x !== null)
			const names = [...existing, ...created]
			return {
				stdout: JSON.stringify(
					names.length > 0 ? names.map((name) => ({ name, status: 'Running' })) : [],
				),
				stderr: '',
			}
		}
		return { stdout: '', stderr: '' }
	}
	return { run, calls }
}

let sessionRoot: string

beforeEach(async () => {
	sessionRoot = await mkdtemp(join(tmpdir(), 'maskin-agent-server-'))
})

afterEach(async () => {
	await rm(sessionRoot, { recursive: true, force: true })
})

describe('GET /health', () => {
	it('returns the shape HOST_SETUP.md §9 expects', async () => {
		const { run } = makeRunner()
		const app = buildApp({
			env: makeEnv(),
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
		})
		const res = await app.request('/health')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			ok: true,
			backend: 'microsandbox',
			msb_version: '0.5.4',
		})
	})

	it('reports unhealthy (503, ok:false) when msb is unavailable', async () => {
		const run = async () => {
			throw new Error('msb: command not found')
		}
		const app = buildApp({
			env: makeEnv(),
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
		})
		const res = await app.request('/health')
		expect(res.status).toBe(503)
		expect(await res.json()).toEqual({
			ok: false,
			backend: 'microsandbox',
			msb_version: null,
		})
	})
})

describe('POST /sessions auth', () => {
	it('returns 401 without a bearer token', async () => {
		const { run } = makeRunner()
		const app = buildApp({
			env: makeEnv({ AGENT_SESSION_ROOT: sessionRoot }),
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
		})
		const res = await app.request('/sessions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sessionId: 'sess-1', image: 'alpine:3.20' }),
		})
		expect(res.status).toBe(401)
	})

	it('returns 401 with the wrong bearer token', async () => {
		const { run } = makeRunner()
		const app = buildApp({
			env: makeEnv({ AGENT_SESSION_ROOT: sessionRoot }),
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
		})
		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer wrong',
			},
			body: JSON.stringify({ sessionId: 'sess-1', image: 'alpine:3.20' }),
		})
		expect(res.status).toBe(401)
	})
})

describe('POST /sessions happy path', () => {
	it('spawns a sandbox and returns connection info', async () => {
		const { run, calls } = makeRunner()
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_AGENT_SERVER_PUBLIC_HOST: 'agent-fi.maskin.test',
		})
		const app = buildApp({
			env,
			storage: null,
			msb: {
				msbBin: '/usr/local/bin/msb',
				run,
				sleep: async () => {},
				now: () => 0,
			},
		})

		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: JSON.stringify({
				sessionId: 'sess-happy',
				image: 'maskin/agent-base:latest',
				env: { FOO: 'bar' },
			}),
		})

		expect(res.status).toBe(201)
		const body = (await res.json()) as {
			sessionId: string
			sandboxName: string
			connection: { host: string; port: number }
		}
		expect(body.sessionId).toBe('sess-happy')
		expect(body.sandboxName).toBe('sess-happy')
		expect(body.connection).toEqual({ host: 'agent-fi.maskin.test', port: 3001 })

		const createCall = calls.find((c) => c.args[0] === 'create')
		expect(createCall).toBeDefined()
		expect(createCall?.args).toContain('--net-rule')
		// The SESSION_MAX_DURATION backstop is threaded into the spawn so a
		// persistent VM can't sit "running" forever if completion never signals.
		const maxIdx = createCall?.args.indexOf('--max-duration') ?? -1
		expect(maxIdx).toBeGreaterThan(-1)
		expect(createCall?.args[maxIdx + 1]).toBe('8h')

		const skel = await readdir(join(sessionRoot, 'sess-happy'))
		expect(skel.sort()).toEqual(['.exec-trigger', 'learnings', 'memory', 'skills', 'workspace'])
	})
})

describe('POST /sessions image warmer integration', () => {
	it('uses --pull missing and reports warm_hit:true when the warmer has the image', async () => {
		const { run, calls } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		let suffix = 0
		const warmer = new ImageWarmer({
			image: 'maskin/agent-base:latest',
			hostPort: env.PORT,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: () => `w${suffix++}`,
		})
		await warmer.start()

		const app = buildApp({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run, sleep: async () => {}, now: () => 0 },
			warmer,
		})

		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: JSON.stringify({
				sessionId: 'sess-warm',
				image: 'maskin/agent-base:latest',
				env: {},
			}),
		})

		expect(res.status).toBe(201)
		const body = (await res.json()) as { warm_hit: boolean }
		expect(body.warm_hit).toBe(true)

		// The session VM's create call carries --pull missing because the warmer
		// guarantees the image is locally cached.
		const sessionCreate = calls
			.filter((c) => c.args[0] === 'create')
			.find((c) => c.args.includes('sess-warm'))
		expect(sessionCreate).toBeDefined()
		const pullIdx = sessionCreate?.args.indexOf('--pull') ?? -1
		expect(sessionCreate?.args[pullIdx + 1]).toBe('if-missing')
	})

	it('falls back to --pull always and warm_hit:false when the image does not match the warmer', async () => {
		const { run, calls } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		let suffix = 0
		const warmer = new ImageWarmer({
			image: 'maskin/agent-base:latest',
			hostPort: env.PORT,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: () => `w${suffix++}`,
		})
		await warmer.start()

		const app = buildApp({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run, sleep: async () => {}, now: () => 0 },
			warmer,
		})

		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: JSON.stringify({
				sessionId: 'sess-cold',
				image: 'other/image:1.0',
				env: {},
			}),
		})

		expect(res.status).toBe(201)
		const body = (await res.json()) as { warm_hit: boolean }
		expect(body.warm_hit).toBe(false)

		const sessionCreate = calls
			.filter((c) => c.args[0] === 'create')
			.find((c) => c.args.includes('sess-cold'))
		expect(sessionCreate).toBeDefined()
		const pullIdx = sessionCreate?.args.indexOf('--pull') ?? -1
		expect(sessionCreate?.args[pullIdx + 1]).toBe('always')
	})
})

describe('POST /sessions validation', () => {
	it('rejects a malformed body with 400', async () => {
		const { run } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/x', run } })
		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: JSON.stringify({ sessionId: '../etc/passwd', image: 'alpine' }),
		})
		expect(res.status).toBe(400)
	})

	it('rejects non-JSON body with 400', async () => {
		const { run } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/x', run } })
		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: 'not-json',
		})
		expect(res.status).toBe(400)
	})

	it('rejects invalid env var keys with 400', async () => {
		const { run } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/x', run } })
		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: JSON.stringify({
				sessionId: 'sess-1',
				image: 'alpine:3.20',
				env: { 'INJECT=evil; rm -rf /': 'value' },
			}),
		})
		expect(res.status).toBe(400)
	})
})

describe('POST /sessions/:id/complete', () => {
	it('is reachable without a bearer token (the VM holds no secret) and stops the sandbox after a deferral', async () => {
		vi.useFakeTimers()
		try {
			const { run, calls } = makeRunner()
			const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
			const app = buildApp({ env, storage: null, msb: { msbBin: '/usr/local/bin/msb', run } })

			const res = await app.request('/sessions/sess-done/complete', { method: 'POST' })

			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ ok: true })
			// The stop MUST be deferred so this response flushes back to the VM's
			// report_complete curl before msb tears down the VM network — it must not
			// have fired synchronously.
			expect(calls.find((c) => c.args[0] === 'stop')).toBeUndefined()

			// Once the deferral elapses, the graceful stop fires.
			await vi.advanceTimersByTimeAsync(2_000)
			const stopCall = calls.find((c) => c.args[0] === 'stop')
			expect(stopCall?.args).toEqual(['stop', 'sess-done'])
		} finally {
			vi.useRealTimers()
		}
	})

	it('rejects an invalid session id with 400 and does not shell out', async () => {
		const { run, calls } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/usr/local/bin/msb', run } })

		const res = await app.request('/sessions/-bad/complete', { method: 'POST' })

		expect(res.status).toBe(400)
		await new Promise((r) => setTimeout(r, 0))
		expect(calls.find((c) => c.args[0] === 'stop')).toBeUndefined()
	})
})

describe('POST /sessions/:id/stop', () => {
	it('returns 401 without a bearer token', async () => {
		const { run } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/usr/local/bin/msb', run } })

		const res = await app.request('/sessions/sess-stop/stop', { method: 'POST' })

		expect(res.status).toBe(401)
	})

	it('stops the sandbox immediately (not deferred) given a valid bearer token', async () => {
		const { run, calls } = makeRunner({ existingSandboxes: ['sess-stop'] })
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/usr/local/bin/msb', run } })

		const res = await app.request('/sessions/sess-stop/stop', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ reason: 'stop', source: 'user-stop' }),
		})

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ stopped: 'sandbox-stopped' })
		expect(calls.find((c) => c.args[0] === 'stop')?.args).toEqual(['stop', 'sess-stop'])
	})

	it('is idempotent — reports sandbox-not-found without shelling out when the sandbox is already gone', async () => {
		// A stop request for a session whose sandbox is no longer known to
		// `msb list` used to shell out anyway and swallow the failure — the
		// new handler observes the list first and returns `sandbox-not-found`
		// without invoking `msb stop`, matching the settle-side contract
		// where an absent sandbox is not itself a stop failure.
		const { run, calls } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/usr/local/bin/msb', run } })

		const res = await app.request('/sessions/sess-gone/stop', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ reason: 'complete', source: 'sandbox-exit' }),
		})

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ stopped: 'sandbox-not-found' })
		expect(calls.find((c) => c.args[0] === 'stop')).toBeUndefined()
	})

	it('rejects an invalid session id with 400 and does not shell out', async () => {
		const { run, calls } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/usr/local/bin/msb', run } })

		const res = await app.request('/sessions/-bad/stop', {
			method: 'POST',
			headers: { authorization: `Bearer ${env.AGENT_SERVER_SECRET}` },
		})

		expect(res.status).toBe(400)
		expect(calls.find((c) => c.args[0] === 'stop')).toBeUndefined()
	})
})

describe('POST /sessions/:id/stop — exit code sentinel (Bug 1 regression)', () => {
	it('seeds the forced-stop sentinel into sessionExitCodes before stopping the sandbox', async () => {
		const { run } = makeRunner({ existingSandboxes: ['sess-stop'] })
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const sessionExitCodes = new Map<string, number>()
		const app = buildApp({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			sessionExitCodes,
		})

		const res = await app.request('/sessions/sess-stop/stop', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ reason: 'stop', source: 'user-stop' }),
		})

		expect(res.status).toBe(200)
		expect(sessionExitCodes.get('sess-stop')).toBe(FORCED_STOP_EXIT_CODE)
	})

	it('still seeds the sentinel even when the underlying stopSandbox call fails', async () => {
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		// Sandbox in the `list` output so we reach the `stop` shell-out below,
		// which throws to exercise the "already gone" outcome; the seed must
		// have already happened by then.
		const run = async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'stop') throw new Error('sandbox not found')
			if (args[0] === 'list') {
				return {
					stdout: JSON.stringify([{ name: 'sess-gone', status: 'Running' }]),
					stderr: '',
				}
			}
			return { stdout: '', stderr: '' }
		}
		const sessionExitCodes = new Map<string, number>()
		const app = buildApp({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			sessionExitCodes,
		})

		const res = await app.request('/sessions/sess-gone/stop', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ reason: 'stop', source: 'user-stop' }),
		})

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ stopped: 'sandbox-already-gone' })
		expect(sessionExitCodes.get('sess-gone')).toBe(FORCED_STOP_EXIT_CODE)
	})

	it('does not seed a sentinel for an invalid session id (rejected before the handler body runs)', async () => {
		const { run } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const sessionExitCodes = new Map<string, number>()
		const app = buildApp({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			sessionExitCodes,
		})

		const res = await app.request('/sessions/-bad/stop', {
			method: 'POST',
			headers: { authorization: `Bearer ${env.AGENT_SERVER_SECRET}` },
		})

		expect(res.status).toBe(400)
		expect(sessionExitCodes.size).toBe(0)
	})

	it('self-cleans an orphaned sentinel after the TTL elapses (no live monitor ever consumed it)', async () => {
		const { run } = makeRunner({ existingSandboxes: ['sess-orphan'] })
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const sessionExitCodes = new Map<string, number>()
		const app = buildApp({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			sessionExitCodes,
		})

		vi.useFakeTimers()
		try {
			const res = await app.request('/sessions/sess-orphan/stop', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ reason: 'stop', source: 'user-stop' }),
			})
			expect(res.status).toBe(200)
			expect(sessionExitCodes.get('sess-orphan')).toBe(FORCED_STOP_EXIT_CODE)

			await vi.advanceTimersByTimeAsync(SESSION_EXIT_CODE_SENTINEL_TTL_MS)

			expect(sessionExitCodes.has('sess-orphan')).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it('does not clobber a value a live monitor already wrote over the sentinel before the TTL fires', async () => {
		const { run } = makeRunner({ existingSandboxes: ['sess-raced'] })
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const sessionExitCodes = new Map<string, number>()
		const app = buildApp({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			sessionExitCodes,
		})

		vi.useFakeTimers()
		try {
			const res = await app.request('/sessions/sess-raced/stop', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ reason: 'stop', source: 'user-stop' }),
			})
			expect(res.status).toBe(200)

			// Simulate /complete reporting a real exit code for this session before
			// the cleanup timer fires — the sentinel's cleanup must not delete a
			// value it didn't write.
			sessionExitCodes.set('sess-raced', 0)

			await vi.advanceTimersByTimeAsync(SESSION_EXIT_CODE_SENTINEL_TTL_MS)

			expect(sessionExitCodes.get('sess-raced')).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('POST /sessions drain flag', () => {
	it('returns 503 and does not spawn when draining', async () => {
		const { run, calls } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			drainState: { draining: true },
		})

		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: JSON.stringify({ sessionId: 'sess-drain', image: 'maskin/agent-base:latest', env: {} }),
		})

		expect(res.status).toBe(503)
		expect(calls.find((c) => c.args[0] === 'create')).toBeUndefined()
	})

	it('accepts sessions normally when not draining', async () => {
		const { run } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			drainState: { draining: false },
		})

		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: JSON.stringify({
				sessionId: 'sess-not-draining',
				image: 'maskin/agent-base:latest',
				env: {},
			}),
		})

		expect(res.status).toBe(201)
	})
})

describe('POST /sessions readiness gate', () => {
	it('returns 503 and does not spawn while readyState.ready is false', async () => {
		const { run, calls } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			readyState: { ready: false },
		})

		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: JSON.stringify({
				sessionId: 'sess-not-ready',
				image: 'maskin/agent-base:latest',
				env: {},
			}),
		})

		expect(res.status).toBe(503)
		expect(calls.find((c) => c.args[0] === 'create')).toBeUndefined()
	})

	it('accepts sessions once readyState.ready is true', async () => {
		const { run } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			readyState: { ready: true },
		})

		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: JSON.stringify({ sessionId: 'sess-ready', image: 'maskin/agent-base:latest', env: {} }),
		})

		expect(res.status).toBe(201)
	})

	it('accepts sessions when readyState is omitted entirely (existing test/caller default)', async () => {
		const { run } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
		})

		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: JSON.stringify({
				sessionId: 'sess-no-readystate',
				image: 'maskin/agent-base:latest',
				env: {},
			}),
		})

		expect(res.status).toBe(201)
	})
})

describe('reconcileOnBoot', () => {
	function makeReconcileRunner(sandboxes: Array<{ name: string; status: string }>) {
		const calls: Array<{ args: readonly string[] }> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push({ args })
			if (args[0] === 'list') {
				// First `list` call is listSandboxNames' boot snapshot; every call
				// after that belongs to a reattached monitorSession's waitForCompletion
				// poll — report those sandboxes gone so the reattached watcher
				// resolves immediately instead of polling forever in the test.
				const listCallCount = calls.filter((c) => c.args[0] === 'list').length
				return { stdout: JSON.stringify(listCallCount === 1 ? sandboxes : []), stderr: '' }
			}
			return { stdout: '', stderr: '' }
		}
		return { run, calls }
	}

	it('skips entirely when AGENT_SERVER_ID is unset', async () => {
		const { run, calls } = makeReconcileRunner([{ name: 'sess-1', status: 'Running' }])
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot, MASKIN_BASE_URL: 'http://maskin.test' })
		const fetchImpl = vi.fn()

		await reconcileOnBoot({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			sessionLogRouters: new Map(),
			sessionExitCodes: new Map(),
			fetchImpl,
		})

		expect(calls.length).toBe(0)
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('skips entirely when MASKIN_BASE_URL is unset', async () => {
		const { run, calls } = makeReconcileRunner([{ name: 'sess-1', status: 'Running' }])
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const fetchImpl = vi.fn()

		await reconcileOnBoot({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			sessionLogRouters: new Map(),
			sessionExitCodes: new Map(),
			fetchImpl,
		})

		expect(calls.length).toBe(0)
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('removes every orphan sandbox reported by /reconcile', async () => {
		const { run, calls } = makeReconcileRunner([
			{ name: 'sess-1', status: 'Running' },
			{ name: 'sess-orphan', status: 'Running' },
		])
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ marked_failed: ['some-uuid'], orphan_sandboxes: ['sess-orphan'] }),
		}))

		await reconcileOnBoot({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			sessionLogRouters: new Map(),
			sessionExitCodes: new Map(),
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})

		const removeCall = calls.find((c) => c.args[0] === 'remove')
		expect(removeCall?.args).toEqual(['remove', '-f', '--quiet', 'sess-orphan'])
	})

	it('reattaches a monitor for a claimed (non-orphan) sandbox instead of removing it', async () => {
		const { run, calls } = makeReconcileRunner([{ name: 'sess-claimed', status: 'Running' }])
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ({
			ok: true,
			json: async () => ({ marked_failed: [], orphan_sandboxes: [] }),
		}))
		const sessionLogRouters = new Map<string, (line: string) => void>()

		await reconcileOnBoot({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			sessionLogRouters,
			sessionExitCodes: new Map(),
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})

		// Never treated as an orphan.
		expect(calls.find((c) => c.args[0] === 'remove')).toBeUndefined()
		// monitorSession registers a log-router entry for its sessionId
		// synchronously, before its first await (see index.ts) — its presence
		// here proves reconcileOnBoot actually invoked monitorSession for this
		// sandbox with the derived sessionDir, not just that it was spared from
		// removal. (monitorSession's own waitForCompletion poll uses a real,
		// non-injectable timer — asserting on it finishing is exercised by the
		// existing POST /sessions tests, not duplicated here.)
		expect(sessionLogRouters.has('sess-claimed')).toBe(true)
	})

	it('recovers a session exit code and re-issues its stop from an on-disk marker', async () => {
		const sessionId = 'sess-recovered'
		await mkdir(join(sessionRoot, sessionId), { recursive: true })
		// Simulates POST /sessions/:id/complete having recorded exitCode 3 and
		// scheduled its deferred stopSandbox call in the OLD process, right
		// before that process was killed/restarted before the timer fired — the
		// sandbox is therefore still "Running" in msb list on this boot.
		await writeFile(join(sessionRoot, sessionId, '.exit-code'), '3', 'utf8')

		const { run, calls } = makeReconcileRunner([{ name: sessionId, status: 'Running' }])
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ({
			ok: true,
			json: async () => ({ marked_failed: [], orphan_sandboxes: [] }),
		}))
		const sessionExitCodes = new Map<string, number>()

		await reconcileOnBoot({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			sessionLogRouters: new Map(),
			sessionExitCodes,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})

		// Real exit code recovered from disk instead of defaulting to 0.
		expect(sessionExitCodes.get(sessionId)).toBe(3)
		// The lost deferred stop is re-issued directly (idempotent — safe even
		// if the original timer actually did fire before the process died).
		const stopCall = calls.find((c) => c.args[0] === 'stop')
		expect(stopCall?.args).toEqual(['stop', sessionId])
	})

	it('does not recover an exit code or re-issue a stop when no marker exists on disk', async () => {
		const sessionId = 'sess-still-running'
		await mkdir(join(sessionRoot, sessionId), { recursive: true })

		const { run, calls } = makeReconcileRunner([{ name: sessionId, status: 'Running' }])
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ({
			ok: true,
			json: async () => ({ marked_failed: [], orphan_sandboxes: [] }),
		}))
		const sessionExitCodes = new Map<string, number>()

		await reconcileOnBoot({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			sessionLogRouters: new Map(),
			sessionExitCodes,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})

		expect(sessionExitCodes.has(sessionId)).toBe(false)
		expect(calls.find((c) => c.args[0] === 'stop')).toBeUndefined()
	})

	it('skips the reconcile call and logs when msb list fails', async () => {
		const run = async (): Promise<{ stdout: string; stderr: string }> => {
			throw new Error('msb list failed')
		}
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const fetchImpl = vi.fn()

		await reconcileOnBoot({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			sessionLogRouters: new Map(),
			sessionExitCodes: new Map(),
			fetchImpl,
		})

		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('does not throw when the /reconcile call itself rejects', async () => {
		const { run } = makeReconcileRunner([{ name: 'sess-1', status: 'Running' }])
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const fetchImpl = vi.fn(async () => {
			throw new Error('network down')
		})

		await expect(
			reconcileOnBoot({
				env,
				storage: null,
				msb: { msbBin: '/usr/local/bin/msb', run },
				sessionLogRouters: new Map(),
				sessionExitCodes: new Map(),
				fetchImpl,
			}),
		).resolves.toBeUndefined()
	})

	it('does not throw and removes nothing when /reconcile responds non-ok', async () => {
		const { run, calls } = makeReconcileRunner([{ name: 'sess-1', status: 'Running' }])
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }))

		await reconcileOnBoot({
			env,
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			sessionLogRouters: new Map(),
			sessionExitCodes: new Map(),
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})

		expect(calls.find((c) => c.args[0] === 'remove')).toBeUndefined()
	})
})

describe('monitorSession — flushLogs retry and drop marker', () => {
	// monitorSession isn't exported directly; reattach one via reconcileOnBoot
	// (same pattern as the 'reattaches a monitor for a claimed sandbox' test
	// above) to get a live sessionLogRouters push function, then drive its
	// internal flushLogs through fake timers and a stubbed global fetch.
	function makeAlwaysRunningRunner(sessionName: string) {
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			if (args[0] === 'list') {
				return { stdout: JSON.stringify([{ name: sessionName, status: 'Running' }]), stderr: '' }
			}
			return { stdout: '', stderr: '' }
		}
		return run
	}

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('retries a failed log flush and succeeds on a later attempt', async () => {
		const sessionId = 'sess-flush-retry'
		const run = makeAlwaysRunningRunner(sessionId)
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const reconcileFetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ marked_failed: [], orphan_sandboxes: [] }),
		}))
		const sessionLogRouters = new Map<string, (line: string) => void>()

		const logsFetch = vi
			.fn()
			.mockRejectedValueOnce(new Error('network blip'))
			.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
		vi.stubGlobal('fetch', logsFetch)

		vi.useFakeTimers()
		try {
			await reconcileOnBoot({
				env,
				storage: null,
				msb: { msbBin: '/usr/local/bin/msb', run },
				sessionLogRouters,
				sessionExitCodes: new Map(),
				fetchImpl: reconcileFetch as unknown as typeof fetch,
			})

			const push = sessionLogRouters.get(sessionId)
			expect(push).toBeDefined()
			push?.('hello world')

			// First flush fires after LOG_FLUSH_INTERVAL_MS (2s) and fails; the
			// retry fires after the first backoff delay (2s) and succeeds.
			await vi.advanceTimersByTimeAsync(2_000)
			await vi.advanceTimersByTimeAsync(2_000)
		} finally {
			vi.useRealTimers()
		}

		expect(logsFetch).toHaveBeenCalledTimes(2)
		const secondCall = logsFetch.mock.calls[1]
		if (!secondCall) throw new Error('logsFetch was not called a second time')
		const body = JSON.parse(secondCall[1].body as string) as {
			logs: Array<{ stream: string; content: string }>
		}
		expect(body.logs).toEqual([{ stream: 'stdout', content: 'hello world' }])
	})

	it('abandons log delivery for the whole session on a 410, without retrying', async () => {
		// A session hard-deleted while its sandbox is still alive makes every
		// further ingest fail the session_logs foreign key, so Maskin answers a
		// terminal 410. Retrying (6 attempts, ~46s) achieves nothing and repeats
		// for every remaining batch — the storm behind Sentry MASKIN-DEV-5 /
		// MASKIN-AGENT-SERVER-1. One warn, no retries, and no further POSTs.
		const sessionId = 'sess-flush-gone'
		const run = makeAlwaysRunningRunner(sessionId)
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const reconcileFetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ marked_failed: [], orphan_sandboxes: [] }),
		}))
		const sessionLogRouters = new Map<string, (line: string) => void>()

		const logsFetch = vi.fn().mockResolvedValue({ ok: false, status: 410, json: async () => ({}) })
		vi.stubGlobal('fetch', logsFetch)
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})

		vi.useFakeTimers()
		try {
			await reconcileOnBoot({
				env,
				storage: null,
				msb: { msbBin: '/usr/local/bin/msb', run },
				sessionLogRouters,
				sessionExitCodes: new Map(),
				fetchImpl: reconcileFetch as unknown as typeof fetch,
			})

			const push = sessionLogRouters.get(sessionId)
			expect(push).toBeDefined()
			push?.('first line')
			await vi.advanceTimersByTimeAsync(2_000)
			// A later batch must not re-attempt delivery either.
			push?.('second line')
			await vi.advanceTimersByTimeAsync(60_000)
		} finally {
			vi.useRealTimers()
		}

		expect(logsFetch).toHaveBeenCalledTimes(1)
		expect(warnSpy).toHaveBeenCalledWith(
			'Maskin reports session is gone — abandoning log delivery',
			expect.objectContaining({ sessionId, droppedLines: 1 }),
		)
		expect(errorSpy).not.toHaveBeenCalledWith(
			'failed to POST logs to Maskin after all retries, batch dropped',
			expect.anything(),
		)
		warnSpy.mockRestore()
		errorSpy.mockRestore()
	})

	it('retries a 401 rather than dropping the batch', async () => {
		// A 401 is NOT a permanent client fault here: an AGENT_SERVER_SECRET
		// rotation or a mid-deploy config gap produces auth failures inside the
		// same ~30s window the retry budget exists to survive. Dropping the batch
		// on the first 401 silently deletes lines from the user's transcript.
		const sessionId = 'sess-flush-401'
		const run = makeAlwaysRunningRunner(sessionId)
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const reconcileFetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ marked_failed: [], orphan_sandboxes: [] }),
		}))
		const sessionLogRouters = new Map<string, (line: string) => void>()

		// Fails auth twice (secret rotation in flight), then recovers.
		const logsFetch = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
			.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
			.mockResolvedValue({ ok: true, status: 200, json: async () => ({ accepted: 1 }) })
		vi.stubGlobal('fetch', logsFetch)

		vi.useFakeTimers()
		try {
			await reconcileOnBoot({
				env,
				storage: null,
				msb: { msbBin: '/usr/local/bin/msb', run },
				sessionLogRouters,
				sessionExitCodes: new Map(),
				fetchImpl: reconcileFetch as unknown as typeof fetch,
			})

			const push = sessionLogRouters.get(sessionId)
			expect(push).toBeDefined()
			push?.('line through the rotation')
			await vi.advanceTimersByTimeAsync(60_000)
		} finally {
			vi.useRealTimers()
		}

		// Three attempts: two rejected, the third delivering the same batch.
		expect(logsFetch).toHaveBeenCalledTimes(3)
		const finalCall = logsFetch.mock.calls[2]
		if (!finalCall) throw new Error('logsFetch was not retried to success')
		const body = JSON.parse(finalCall[1].body as string) as {
			logs: Array<{ stream: string; content: string }>
		}
		expect(body.logs).toEqual([{ stream: 'stdout', content: 'line through the rotation' }])
	})

	it('warns when the server reports fewer accepted lines than were sent, without retrying', async () => {
		// Regression coverage: a 200 response can still mean a partial batch —
		// the server rejects any oversized/invalid line rather than failing the
		// whole batch — but flushLogs() used to return on any `res.ok` without
		// ever reading the response body, so a partial accept was silently
		// indistinguishable from full success. That's the same kind of invisible
		// log loss this whole batching/truncation mechanism exists to fix.
		const sessionId = 'sess-flush-partial-accept'
		const run = makeAlwaysRunningRunner(sessionId)
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const reconcileFetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ marked_failed: [], orphan_sandboxes: [] }),
		}))
		const sessionLogRouters = new Map<string, (line: string) => void>()

		const logsFetch = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, json: async () => ({ accepted: 1 }) })
		vi.stubGlobal('fetch', logsFetch)
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

		vi.useFakeTimers()
		try {
			await reconcileOnBoot({
				env,
				storage: null,
				msb: { msbBin: '/usr/local/bin/msb', run },
				sessionLogRouters,
				sessionExitCodes: new Map(),
				fetchImpl: reconcileFetch as unknown as typeof fetch,
			})

			const push = sessionLogRouters.get(sessionId)
			expect(push).toBeDefined()
			push?.('line one')
			push?.('line two')

			await vi.advanceTimersByTimeAsync(2_000)
		} finally {
			vi.useRealTimers()
		}

		// Accepted (200) on the first attempt — no retry for a partial accept.
		expect(logsFetch).toHaveBeenCalledTimes(1)
		expect(warnSpy).toHaveBeenCalledWith(
			'Maskin log ingest accepted fewer lines than sent',
			expect.objectContaining({ sessionId, sent: 2, accepted: 1 }),
		)
	})

	it('drops a batch after exhausting retries and queues a marker for the next flush', async () => {
		const sessionId = 'sess-flush-drop'
		const run = makeAlwaysRunningRunner(sessionId)
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const reconcileFetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ marked_failed: [], orphan_sandboxes: [] }),
		}))
		const sessionLogRouters = new Map<string, (line: string) => void>()

		const logsFetch = vi
			.fn()
			.mockRejectedValueOnce(new Error('network blip 1'))
			.mockRejectedValueOnce(new Error('network blip 2'))
			.mockRejectedValueOnce(new Error('network blip 3'))
			.mockRejectedValueOnce(new Error('network blip 4'))
			.mockRejectedValueOnce(new Error('network blip 5'))
			.mockRejectedValueOnce(new Error('network blip 6'))
			.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
		vi.stubGlobal('fetch', logsFetch)

		vi.useFakeTimers()
		try {
			await reconcileOnBoot({
				env,
				storage: null,
				msb: { msbBin: '/usr/local/bin/msb', run },
				sessionLogRouters,
				sessionExitCodes: new Map(),
				fetchImpl: reconcileFetch as unknown as typeof fetch,
			})

			const push = sessionLogRouters.get(sessionId)
			expect(push).toBeDefined()
			push?.('first batch, will be dropped')

			// LOG_FLUSH_RETRIES = 6 with exponential backoff (2s, 4s, 8s, 16s, 16s
			// capped), plus the initial 2s flush-interval wait before attempt 1.
			await vi.advanceTimersByTimeAsync(2_000) // scheduled flush fires, attempt 1 fails
			await vi.advanceTimersByTimeAsync(2_000) // attempt 2 fails
			await vi.advanceTimersByTimeAsync(4_000) // attempt 3 fails
			await vi.advanceTimersByTimeAsync(8_000) // attempt 4 fails
			await vi.advanceTimersByTimeAsync(16_000) // attempt 5 fails
			await vi.advanceTimersByTimeAsync(16_000) // attempt 6 fails, retries exhausted

			expect(logsFetch).toHaveBeenCalledTimes(6)

			// A later line arriving after the drop schedules the next flush, which
			// should carry both the marker and the new line.
			push?.('second batch, should succeed')
			await vi.advanceTimersByTimeAsync(2_000)
		} finally {
			vi.useRealTimers()
		}

		expect(logsFetch).toHaveBeenCalledTimes(7)
		const seventhCall = logsFetch.mock.calls[6]
		if (!seventhCall) throw new Error('logsFetch was not called a seventh time')
		const body = JSON.parse(seventhCall[1].body as string) as {
			logs: Array<{ stream: string; content: string }>
		}
		expect(body.logs).toEqual([
			{
				stream: 'stdout',
				content: '[system] 1 log lines failed to reach Maskin after 6 attempts and were dropped\n',
			},
			{ stream: 'stdout', content: 'second batch, should succeed' },
		])
	})

	it('drops a batch without retrying when Maskin resolves with a non-retryable status', async () => {
		const sessionId = 'sess-flush-http-error'
		const run = makeAlwaysRunningRunner(sessionId)
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const reconcileFetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ marked_failed: [], orphan_sandboxes: [] }),
		}))
		const sessionLogRouters = new Map<string, (line: string) => void>()

		// A resolved 400 never rejects fetch() — it must still be treated as a
		// failure (dropped with a marker), not silently accepted. A malformed
		// batch is a genuine client fault that answers identically however many
		// times it is sent, so it must not spend the retry budget.
		//
		// This assertion used a 401 until it was found to be the wrong call:
		// auth failures are NOT a stable config fault here. An
		// AGENT_SERVER_SECRET rotation or a mid-deploy config gap answers 401 for
		// seconds and then recovers, inside the very window this retry budget was
		// widened to survive. Dropping on the first 401 turns a transient
		// rotation into permanent, unrecoverable loss of the user's transcript,
		// whereas retrying a genuinely-bad token costs a bounded ~46s and then
		// drops with the same marker. See the 401 test above.
		const logsFetch = vi.fn(async () => ({
			ok: false,
			status: 400,
			json: async () => ({}),
		}))
		vi.stubGlobal('fetch', logsFetch)
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})

		vi.useFakeTimers()
		try {
			await reconcileOnBoot({
				env,
				storage: null,
				msb: { msbBin: '/usr/local/bin/msb', run },
				sessionLogRouters,
				sessionExitCodes: new Map(),
				fetchImpl: reconcileFetch as unknown as typeof fetch,
			})

			const push = sessionLogRouters.get(sessionId)
			expect(push).toBeDefined()
			push?.('will be dropped after a 400')

			await vi.advanceTimersByTimeAsync(2_000) // scheduled flush fires: 400, dropped
			await vi.advanceTimersByTimeAsync(48_000) // no retry occupies the old ~46s window
		} finally {
			vi.useRealTimers()
		}

		expect(logsFetch).toHaveBeenCalledTimes(1)
		expect(errorSpy).toHaveBeenCalledWith(
			'Maskin rejected log batch as non-retryable, batch dropped',
			expect.objectContaining({ sessionId, status: 400, droppedLines: 1 }),
		)
		errorSpy.mockRestore()
	})
})

describe('monitorSession — completion report retry and drop marker', () => {
	// Same reattach-via-reconcileOnBoot approach as the flushLogs describe
	// above, but the runner reports the sandbox gone on the second `list` call
	// so waitForCompletion resolves quickly and monitorSession reaches its
	// completion-report retry loop.
	function makeCompletingRunner(sessionName: string) {
		const calls: Array<{ args: readonly string[] }> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push({ args })
			if (args[0] === 'list') {
				const listCallCount = calls.filter((c) => c.args[0] === 'list').length
				// First list call is listSandboxNames' boot snapshot; every call
				// after that belongs to monitorSession's waitForCompletion poll.
				return {
					stdout: JSON.stringify(
						listCallCount === 1 ? [{ name: sessionName, status: 'Running' }] : [],
					),
					stderr: '',
				}
			}
			return { stdout: '', stderr: '' }
		}
		return run
	}

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('retries a failed completion report and succeeds on a later attempt', async () => {
		const sessionId = 'sess-report-retry'
		const run = makeCompletingRunner(sessionId)
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const reconcileFetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ marked_failed: [], orphan_sandboxes: [] }),
		}))
		await mkdir(join(sessionRoot, sessionId), { recursive: true })

		const completionFetch = vi
			.fn()
			.mockRejectedValueOnce(new Error('network blip'))
			.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
		vi.stubGlobal('fetch', completionFetch)

		vi.useFakeTimers()
		try {
			await reconcileOnBoot({
				env,
				storage: null,
				msb: { msbBin: '/usr/local/bin/msb', run },
				sessionLogRouters: new Map(),
				sessionExitCodes: new Map(),
				fetchImpl: reconcileFetch as unknown as typeof fetch,
			})

			// waitForCompletion's first poll (5s) sees the sandbox gone and
			// resolves; the first report attempt fires immediately after and
			// fails, the retry fires after the first backoff delay (5s) and
			// succeeds.
			await vi.advanceTimersByTimeAsync(5_000)
			await vi.advanceTimersByTimeAsync(5_000)
		} finally {
			vi.useRealTimers()
		}

		expect(completionFetch).toHaveBeenCalledTimes(2)
		const secondCall = completionFetch.mock.calls[1]
		if (!secondCall) throw new Error('completionFetch was not called a second time')
		const [url, init] = secondCall as [string, RequestInit]
		expect(url).toBe(`http://maskin.test/api/internal/agent-servers/sessions/${sessionId}/complete`)
		const body = JSON.parse(init.body as string) as { exitCode: number }
		expect(body.exitCode).toBe(0)
	})

	it('drops the completion report after exhausting retries and logs the orphan warning', async () => {
		const sessionId = 'sess-report-drop'
		const run = makeCompletingRunner(sessionId)
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const reconcileFetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ marked_failed: [], orphan_sandboxes: [] }),
		}))
		await mkdir(join(sessionRoot, sessionId), { recursive: true })

		const completionFetch = vi.fn(async () => {
			throw new Error('network down')
		})
		vi.stubGlobal('fetch', completionFetch)
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})

		vi.useFakeTimers()
		try {
			await reconcileOnBoot({
				env,
				storage: null,
				msb: { msbBin: '/usr/local/bin/msb', run },
				sessionLogRouters: new Map(),
				sessionExitCodes: new Map(),
				fetchImpl: reconcileFetch as unknown as typeof fetch,
			})

			// REPORT_RETRIES = 6 with exponential backoff (5s, 10s, 20s, 40s, 40s
			// capped), plus the initial 5s waitForCompletion poll before attempt 1.
			await vi.advanceTimersByTimeAsync(5_000) // waitForCompletion resolves, attempt 1 fails
			await vi.advanceTimersByTimeAsync(5_000) // attempt 2 fails
			await vi.advanceTimersByTimeAsync(10_000) // attempt 3 fails
			await vi.advanceTimersByTimeAsync(20_000) // attempt 4 fails
			await vi.advanceTimersByTimeAsync(40_000) // attempt 5 fails
			await vi.advanceTimersByTimeAsync(40_000) // attempt 6 fails, retries exhausted
		} finally {
			vi.useRealTimers()
		}

		expect(completionFetch).toHaveBeenCalledTimes(6)
		expect(errorSpy).toHaveBeenCalledWith(
			'session completion report failed after all retries — session may appear running until watchdog fires',
			expect.objectContaining({ sessionId, exitCode: 0 }),
		)
	})
})

describe('monitorSession — exit code and lost workspace save', () => {
	// Same reattach-via-reconcileOnBoot approach as the completion-report
	// describe above, with the sandbox reported gone on the second `list`.
	function makeCompletingRunner(sessionName: string) {
		let listCalls = 0
		return async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			if (args[0] === 'list') {
				listCalls++
				return {
					stdout: JSON.stringify(listCalls === 1 ? [{ name: sessionName, status: 'Running' }] : []),
					stderr: '',
				}
			}
			return { stdout: '', stderr: '' }
		}
	}

	// Storage whose upload is throttled for good, so the push gives up after
	// its retries (the production "SlowDown" case).
	const throttledStorage = {
		put: async () => {
			throw new Error('SlowDown: Please reduce your request rate.')
		},
	} as unknown as StorageProvider

	type Posted = { url: string; body: Record<string, unknown> }

	async function runSession(opts: {
		sessionId: string
		storage: StorageProvider | null
		exitCode?: number
		lines?: string[]
	}): Promise<Posted[]> {
		const { sessionId } = opts
		const env = makeEnv({
			AGENT_SESSION_ROOT: sessionRoot,
			MASKIN_BASE_URL: 'http://maskin.test',
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		const reconcileFetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ marked_failed: [], orphan_sandboxes: [] }),
		}))
		await mkdir(join(sessionRoot, sessionId), { recursive: true })

		const posted: Posted[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: RequestInit) => {
				posted.push({ url, body: JSON.parse(init.body as string) })
				return { ok: true, json: async () => ({}) }
			}),
		)
		const sessionLogRouters = new Map<string, (line: string) => void>()
		const sessionExitCodes = new Map<string, number>()
		if (opts.exitCode !== undefined) sessionExitCodes.set(sessionId, opts.exitCode)

		// The workspace archive is built by a real tar child process, so real time
		// has to pass between fake-timer steps.
		const realSetTimeout = globalThis.setTimeout
		vi.useFakeTimers()
		try {
			await reconcileOnBoot({
				env,
				storage: opts.storage,
				msb: { msbBin: '/usr/local/bin/msb', run: makeCompletingRunner(sessionId) },
				sessionLogRouters,
				sessionExitCodes,
				fetchImpl: reconcileFetch as unknown as typeof fetch,
			})
			for (const line of opts.lines ?? []) sessionLogRouters.get(sessionId)?.(line)

			for (let i = 0; i < 100 && !posted.some((p) => p.url.endsWith('/complete')); i++) {
				await vi.advanceTimersByTimeAsync(5_000)
				await new Promise((resolve) => realSetTimeout(resolve, 10))
			}
		} finally {
			vi.useRealTimers()
		}
		return posted
	}

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('keeps a clean run completed and logs a lost workspace when only the save fails', async () => {
		const sessionId = 'sess-save-lost'
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
		vi.spyOn(logger, 'warn').mockImplementation(() => {})

		const posted = await runSession({ sessionId, storage: throttledStorage })

		const complete = posted.find((p) => p.url.endsWith(`/sessions/${sessionId}/complete`))
		expect(complete?.body).toEqual({ exitCode: 0 })
		const logged = posted
			.filter((p) => p.url.endsWith(`/sessions/${sessionId}/logs`))
			.flatMap((p) => (p.body.logs as Array<{ content: string }>).map((l) => l.content))
		expect(logged.some((l) => l.startsWith('[system] workspace lost:'))).toBe(true)
		expect(errorSpy).toHaveBeenCalledWith(
			'session workspace push failed after retries',
			expect.objectContaining({ sessionId }),
		)
	})

	it('still reports a non-zero exit code as failed, with or without a lost save', async () => {
		vi.spyOn(logger, 'error').mockImplementation(() => {})
		vi.spyOn(logger, 'warn').mockImplementation(() => {})

		const plain = await runSession({ sessionId: 'sess-exit-2', storage: null, exitCode: 2 })
		const withLostSave = await runSession({
			sessionId: 'sess-exit-3',
			storage: throttledStorage,
			exitCode: 3,
		})

		expect(plain.find((p) => p.url.endsWith('/complete'))?.body).toEqual({ exitCode: 2 })
		expect(withLostSave.find((p) => p.url.endsWith('/complete'))?.body).toEqual({ exitCode: 3 })
	})

	it('writes the last output lines to the host log when the exit code is non-zero', async () => {
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
		const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`)

		await runSession({ sessionId: 'sess-tail', storage: null, exitCode: 1, lines })

		expect(warnSpy).toHaveBeenCalledWith('session exited non-zero, last output lines follow', {
			sessionId: 'sess-tail',
			exitCode: 1,
			lastLines: lines.slice(5),
		})
	})

	it('does not log an output tail when the exit code is zero', async () => {
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

		await runSession({ sessionId: 'sess-clean', storage: null, lines: ['all good'] })

		expect(warnSpy).not.toHaveBeenCalledWith(
			'session exited non-zero, last output lines follow',
			expect.anything(),
		)
	})
})

describe('POST /sessions/:id/logs/batch', () => {
	const postBatch = (
		app: ReturnType<typeof buildApp>,
		id: string,
		from: number,
		lines: unknown[],
	) =>
		app.request(`/sessions/${id}/logs/batch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer test-secret-thirty-two-chars-long',
			},
			body: JSON.stringify({ from, lines }),
		})

	const appWithRouter = (id: string) => {
		const { run } = makeRunner()
		const seen: string[] = []
		const sessionLogRouters = new Map<string, (line: string) => void>()
		sessionLogRouters.set(id, (line) => seen.push(line))
		const app = buildApp({
			env: makeEnv({ AGENT_SESSION_ROOT: sessionRoot }),
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			sessionLogRouters,
		})
		return { app, seen }
	}

	it('stores a batch and acks the highest sequence it kept', async () => {
		const { app, seen } = appWithRouter('sess-batch-1')
		const res = await postBatch(app, 'sess-batch-1', 1, ['a', 'b', 'c'])
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ack: 3 })
		expect(seen).toEqual(['a', 'b', 'c'])
	})

	// The guest resends anything it has not seen acked, so a lost ack means the
	// same batch arrives twice. Appending it again would duplicate the agent's
	// output in the transcript.
	it('is idempotent when a batch whose ack was lost is resent', async () => {
		const { app, seen } = appWithRouter('sess-batch-2')
		await postBatch(app, 'sess-batch-2', 1, ['a', 'b'])
		const res = await postBatch(app, 'sess-batch-2', 1, ['a', 'b'])
		expect(await res.json()).toEqual({ ack: 2 })
		expect(seen).toEqual(['a', 'b'])
	})

	it('appends only the new lines when a resend overlaps', async () => {
		const { app, seen } = appWithRouter('sess-batch-3')
		await postBatch(app, 'sess-batch-3', 1, ['a', 'b'])
		const res = await postBatch(app, 'sess-batch-3', 2, ['b', 'c', 'd'])
		expect(await res.json()).toEqual({ ack: 4 })
		expect(seen).toEqual(['a', 'b', 'c', 'd'])
	})

	// Acking past a gap would let the guest discard lines that never arrived.
	it('refuses to ack past a gap', async () => {
		const { app, seen } = appWithRouter('sess-batch-4')
		await postBatch(app, 'sess-batch-4', 1, ['a'])
		const res = await postBatch(app, 'sess-batch-4', 3, ['c', 'd'])
		expect(await res.json()).toEqual({ ack: 1 })
		expect(seen).toEqual(['a'])
	})

	it('rejects a malformed body', async () => {
		const { app } = appWithRouter('sess-batch-5')
		expect((await postBatch(app, 'sess-batch-5', 0, ['a'])).status).toBe(400)
		expect((await postBatch(app, 'sess-batch-5', 1, 'not-an-array' as never)).status).toBe(400)
	})

	// Review catch: after an agent-server restart the seq map is empty while the
	// guest is already at sequence N. Refusing that as a gap acked 0 forever
	// against a guest that was long past it — a permanent wedge plus a retry
	// loop measured at ~3,400 requests/second. We have stored nothing, so there
	// is nothing a wrong answer could discard: adopt the guest's position.
	it('adopts the guest position on first contact rather than treating it as a gap', async () => {
		const { app, seen } = appWithRouter('sess-batch-restart')
		const res = await postBatch(app, 'sess-batch-restart', 57, ['after-restart-1', 'x'])
		expect(await res.json()).toEqual({ ack: 58 })
		expect(seen).toEqual(['after-restart-1', 'x'])
	})

	// Review catch: when the guest's buffer overflows it drops its oldest lines,
	// leaving a hole nothing can ever fill. Waiting for it is waiting forever.
	it('accepts a declared resync after the guest dropped lines, and records the hole', async () => {
		const { app, seen } = appWithRouter('sess-batch-drop')
		await postBatch(app, 'sess-batch-drop', 1, ['a', 'b'])

		const res = await app.request('/sessions/sess-batch-drop/logs/batch', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer test-secret-thirty-two-chars-long',
			},
			body: JSON.stringify({ from: 9, lines: ['i', 'j'], resync: true, dropped: 6 }),
		})
		expect(await res.json()).toEqual({ ack: 10 })
		expect(seen[0]).toBe('a')
		expect(seen[1]).toBe('b')
		// The discontinuity is recorded rather than left silent.
		expect(seen[2]).toContain('6 line(s) of agent output were dropped')
		expect(seen.slice(3)).toEqual(['i', 'j'])
	})

	// A gap the guest has NOT declared is still refused: acking it would let the
	// guest discard lines that never arrived.
	it('still refuses an undeclared gap', async () => {
		const { app, seen } = appWithRouter('sess-batch-undeclared')
		await postBatch(app, 'sess-batch-undeclared', 1, ['a'])
		const res = await postBatch(app, 'sess-batch-undeclared', 5, ['e'])
		expect(await res.json()).toEqual({ ack: 1 })
		expect(seen).toEqual(['a'])
	})

	// An unmonitored session must still be acked, or the guest retries forever
	// against a server that is never going to store anything.
	it('acks even when no log router is registered', async () => {
		const { run } = makeRunner()
		const app = buildApp({
			env: makeEnv({ AGENT_SESSION_ROOT: sessionRoot }),
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
		})
		const res = await postBatch(app, 'sess-batch-6', 1, ['a', 'b'])
		expect(await res.json()).toEqual({ ack: 2 })
	})
})

describe('GET /sessions/:id/input/stream', () => {
	it('flushes turns parked before the stream connects and heartbeats the idle connection', async () => {
		vi.useFakeTimers()
		try {
			const { run } = makeRunner()
			const app = buildApp({
				env: makeEnv({ AGENT_SESSION_ROOT: sessionRoot }),
				storage: null,
				msb: { msbBin: '/usr/local/bin/msb', run },
			})

			// A turn arrives while no reader is connected (the VM's input curl
			// dropped) — it must park, not vanish.
			const post = await app.request('/sessions/sess-stream-1/input', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: 'Bearer test-secret-thirty-two-chars-long',
				},
				body: JSON.stringify({ content: 'hello parked turn' }),
			})
			expect(post.status).toBe(200)

			// The (re)connecting reader receives the parked turn immediately.
			const res = await app.request('/sessions/sess-stream-1/input/stream')
			expect(res.status).toBe(200)
			const reader = res.body?.getReader()
			if (!reader) throw new Error('stream response has no body')
			const decoder = new TextDecoder()
			const first = await reader.read()
			const framed = JSON.parse(decoder.decode(first.value))
			// Framed as {maskin_seq, turn} so the VM can ack what it consumed.
			// `turn` is the exact envelope apps/dev put on the wire — the CLI's
			// stdin must see those bytes unaltered.
			expect(framed.maskin_seq).toBe(1)
			expect(JSON.parse(framed.turn)).toEqual({
				type: 'user',
				message: { role: 'user', content: 'hello parked turn' },
			})

			// With nothing else flowing, the 30s keepalive newline arrives — the
			// signal that stops NAT/proxy idle-timeouts from reaping the stream.
			const nextRead = reader.read()
			await vi.advanceTimersByTimeAsync(30_000)
			const heartbeat = await nextRead
			expect(decoder.decode(heartbeat.value)).toBe('\n')

			// Tear the reader down and let the next heartbeat's failed write
			// clean up the interval so the test leaves no live timers behind.
			await reader.cancel()
			await vi.advanceTimersByTimeAsync(30_000)
		} finally {
			vi.useRealTimers()
		}
	})

	it('replays an unacked turn on reconnect and drops it once acked', async () => {
		const { run } = makeRunner()
		const app = buildApp({
			env: makeEnv({ AGENT_SESSION_ROOT: sessionRoot }),
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
		})
		const decoder = new TextDecoder()

		const post = await app.request('/sessions/sess-stream-ack/input', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer test-secret-thirty-two-chars-long',
			},
			body: JSON.stringify({ content: 'needs an ack' }),
		})
		expect(post.status).toBe(200)

		// First reader takes the turn and dies without acking — the production
		// case, where the write succeeded into a socket the VM never read.
		const first = await app.request('/sessions/sess-stream-ack/input/stream')
		const r1 = first.body?.getReader()
		if (!r1) throw new Error('stream response has no body')
		expect(decoder.decode((await r1.read()).value)).toContain('needs an ack')
		await r1.cancel()

		// Reconnect with after=0: the turn is still owed, so it comes again.
		const second = await app.request('/sessions/sess-stream-ack/input/stream?after=0')
		const r2 = second.body?.getReader()
		if (!r2) throw new Error('stream response has no body')
		expect(decoder.decode((await r2.read()).value)).toContain('needs an ack')
		await r2.cancel()

		// Reconnect with after=1: acknowledged, so nothing is replayed. Proven
		// by the 30s heartbeat arriving first instead of a turn.
		vi.useFakeTimers()
		try {
			const third = await app.request('/sessions/sess-stream-ack/input/stream?after=1')
			const r3 = third.body?.getReader()
			if (!r3) throw new Error('stream response has no body')
			const pending = r3.read()
			await vi.advanceTimersByTimeAsync(30_000)
			expect(decoder.decode((await pending).value)).toBe('\n')
			await r3.cancel()
			await vi.advanceTimersByTimeAsync(30_000)
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('stall detection wiring', () => {
	// The predicate itself is covered in stall-tracker.test.ts. What matters here
	// is that the three facts it needs are actually fed to it from the routes —
	// a correct predicate wired to nothing detects nothing, which is exactly how
	// the seedInteractiveTurn bug survived: the local path did the work and the
	// dispatched path silently didn't.
	const auth = {
		'content-type': 'application/json',
		authorization: 'Bearer test-secret-thirty-two-chars-long',
	}

	function setup(thresholdMs = 60_000) {
		let clock = 0
		const stallTracker = new StallTracker({ now: () => clock, thresholdMs })
		const { run } = makeRunner()
		const app = buildApp({
			env: makeEnv({ AGENT_SESSION_ROOT: sessionRoot }),
			storage: null,
			msb: { msbBin: '/usr/local/bin/msb', run },
			stallTracker,
		})
		return {
			app,
			stallTracker,
			advance: (ms: number) => {
				clock += ms
			},
		}
	}

	it('opens a pending window when POST /input delivers a turn', async () => {
		const { app, stallTracker, advance } = setup()
		stallTracker.trackSession('sess-wire-1', { interactive: true })

		const res = await app.request('/sessions/sess-wire-1/input', {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ content: 'are you there?' }),
		})
		expect(res.status).toBe(200)

		advance(60_000)
		expect(stallTracker.counts().undelivered).toBe(1)
	})

	it('queues a model switch as a control request without opening a pending turn', async () => {
		const { app, stallTracker, advance } = setup()
		stallTracker.trackSession('sess-wire-model', { interactive: true })

		const res = await app.request('/sessions/sess-wire-model/input', {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash' }),
		})
		expect(res.status).toBe(200)

		// Delivered to the CLI verbatim and in order with the turns around it.
		const stream = await app.request('/sessions/sess-wire-model/input/stream')
		const reader = stream.body?.getReader()
		if (!reader) throw new Error('stream response has no body')
		const first = await reader.read()
		const framed = JSON.parse(new TextDecoder().decode(first.value))
		const control = JSON.parse(framed.turn)
		expect(control).toMatchObject({
			type: 'control_request',
			request: { subtype: 'set_model', model: 'deepseek/deepseek-v4-flash' },
		})
		expect(typeof control.request_id).toBe('string')
		await reader.cancel()

		// Nothing is waiting on the CLI for a reply, so the stall tracker has no
		// turn to count as undelivered however long this sits.
		advance(120_000)
		expect(stallTracker.counts().undelivered).toBe(0)
	})

	it('rejects a model switch whose model name is not a model name', async () => {
		const { app } = setup()
		for (const model of ['', 'a b', 'x"y', 42, null]) {
			const res = await app.request('/sessions/sess-wire-model-bad/input', {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({ model }),
			})
			expect(res.status).toBe(400)
		}
	})

	it('records the guest ack from the input stream, moving the session to no_output', async () => {
		const { app, stallTracker, advance } = setup()
		stallTracker.trackSession('sess-wire-2', { interactive: true })
		await app.request('/sessions/sess-wire-2/input', {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ content: 'hello' }),
		})

		// The guest connects reporting it consumed seq 1 — the only place that
		// high-water mark is observable in this process.
		const stream = await app.request('/sessions/sess-wire-2/input/stream?after=1')
		expect(stream.status).toBe(200)
		await stream.body?.cancel()

		advance(60_000)
		const counts = stallTracker.counts()
		expect(counts.undelivered).toBe(0)
		expect(counts.no_output).toBe(1)
	})

	it('resets the silence clock on agent output posted to /logs/batch', async () => {
		const { app, stallTracker, advance } = setup()
		stallTracker.trackSession('sess-wire-3', { interactive: true })
		await app.request('/sessions/sess-wire-3/input', {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ content: 'hello' }),
		})
		const stream = await app.request('/sessions/sess-wire-3/input/stream?after=1')
		await stream.body?.cancel()

		advance(30_000)
		const batch = await app.request('/sessions/sess-wire-3/logs/batch', {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ from: 1, lines: [JSON.stringify({ type: 'result' })] }),
		})
		expect(batch.status).toBe(200)

		advance(60_000)
		expect(stallTracker.counts().no_output).toBe(0)
	})
})
