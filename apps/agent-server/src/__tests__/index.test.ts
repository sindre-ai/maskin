import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FORCED_STOP_EXIT_CODE, SESSION_EXIT_CODE_SENTINEL_TTL_MS, buildApp } from '../index'
import type { AgentServerEnv } from '../lib/env'
import { ImageWarmer } from '../services/image-warmer'

function makeEnv(overrides: Partial<AgentServerEnv> = {}): AgentServerEnv {
	return {
		PORT: 3001,
		AGENT_SERVER_SECRET: 'test-secret-thirty-two-chars-long',
		MSB_BIN: '/usr/local/bin/msb',
		AGENT_SESSION_ROOT: '/tmp/agent-server-test',
		S3_REGION: 'us-east-1',
		WARM_POOL_REFRESH_MINUTES: 0,
		BROWSER_SIDECAR_IMAGE: 'browser-sidecar:latest',
		MSB_BRIDGE_GATEWAY: '10.0.1.1',
		SESSION_MAX_DURATION: '8h',
		...overrides,
	}
}

function makeRunner() {
	const calls: Array<{ args: readonly string[] }> = []
	const run = async (
		_bin: string,
		args: readonly string[],
	): Promise<{ stdout: string; stderr: string }> => {
		calls.push({ args })
		if (args[0] === '--version') return { stdout: 'microsandbox 0.5.4', stderr: '' }
		if (args[0] === 'list') {
			const sessionId = calls
				.map((c) => (c.args[0] === 'create' ? c.args[c.args.indexOf('--name') + 1] : null))
				.filter((x): x is string => x !== null)
				.pop()
			return {
				stdout: JSON.stringify(sessionId ? [{ name: sessionId, status: 'Running' }] : []),
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

describe('POST /sessions browserRequired wiring', () => {
	function makeSidecarAwareRunner(opts: { cdpFail?: boolean } = {}) {
		const calls: Array<{ args: readonly string[] }> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push({ args })
			if (args[0] === '--version') return { stdout: 'microsandbox 0.5.4', stderr: '' }
			if (args[0] === 'list') {
				const sessionId = calls
					.map((c) => (c.args[0] === 'create' ? c.args[c.args.indexOf('--name') + 1] : null))
					.filter((x): x is string => x !== null)
					.pop()
				return {
					stdout: JSON.stringify(sessionId ? [{ name: sessionId, status: 'Running' }] : []),
					stderr: '',
				}
			}
			return { stdout: '', stderr: '' }
		}
		const cdpPollReady = opts.cdpFail
			? async () => {
					throw new Error('CDP not ready')
				}
			: async () => {}
		return { run, calls, cdpPollReady }
	}

	it('provisions a sidecar, injects BROWSER_CDP_URL, and adds allow@private when browserRequired=true', async () => {
		const { run, cdpPollReady, calls } = makeSidecarAwareRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({
			env,
			storage: null,
			msb: {
				msbBin: '/usr/local/bin/msb',
				run,
				sleep: async () => {},
				now: () => 0,
				findPort: async () => 39222,
				cdpPollReady,
			},
		})

		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: JSON.stringify({
				sessionId: 'sess-betqa1',
				image: 'maskin/agent-base:latest',
				env: {},
				browserRequired: true,
			}),
		})
		expect(res.status).toBe(201)

		const creates = calls.filter((c) => c.args[0] === 'create')
		const sidecarCreate = creates.find((c) => c.args.includes('anko-browser-sess-betqa1'))
		const sessionCreate = creates.find((c) => c.args.includes('sess-betqa1'))
		expect(sidecarCreate).toBeDefined()
		expect(sessionCreate).toBeDefined()
		// Session VM must carry --net-rule allow@private so it can reach the sidecar.
		expect(sessionCreate?.args).toContain('allow@private')
		// Session VM env must include BROWSER_CDP_URL using the bridge gateway + forwarded port.
		const envFlags =
			sessionCreate?.args.filter((_a, i) => sessionCreate?.args[i - 1] === '-e') ?? []
		expect(envFlags).toContain('BROWSER_CDP_URL=ws://10.0.1.1:39222')
	})

	it('provisions no sidecar, injects no BROWSER_CDP_URL, and omits allow@private when browserRequired is absent', async () => {
		const { run, cdpPollReady, calls } = makeSidecarAwareRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({
			env,
			storage: null,
			msb: {
				msbBin: '/usr/local/bin/msb',
				run,
				sleep: async () => {},
				now: () => 0,
				findPort: async () => 39222,
				cdpPollReady,
			},
		})

		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: JSON.stringify({
				sessionId: 'sess-plain',
				image: 'maskin/agent-base:latest',
				env: {},
			}),
		})
		expect(res.status).toBe(201)

		const creates = calls.filter((c) => c.args[0] === 'create')
		expect(creates.some((c) => c.args.some((a) => a.startsWith('anko-browser-')))).toBe(false)
		const sessionCreate = creates.find((c) => c.args.includes('sess-plain'))
		expect(sessionCreate?.args).not.toContain('allow@private')
		const envFlags =
			sessionCreate?.args.filter((_a, i) => sessionCreate?.args[i - 1] === '-e') ?? []
		expect(envFlags.some((e) => e.startsWith('BROWSER_CDP_URL='))).toBe(false)
	})

	it('still spawns the session (without BROWSER_CDP_URL) when sidecar provisioning fails', async () => {
		// CDP poll times out → provisionBrowserSidecar returns null.
		const { run, cdpPollReady, calls } = makeSidecarAwareRunner({ cdpFail: true })
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({
			env,
			storage: null,
			msb: {
				msbBin: '/usr/local/bin/msb',
				run,
				sleep: async () => {},
				now: () => 0,
				findPort: async () => 39222,
				cdpPollReady,
			},
		})

		const res = await app.request('/sessions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: JSON.stringify({
				sessionId: 'sess-betqa2',
				image: 'maskin/agent-base:latest',
				env: {},
				browserRequired: true,
			}),
		})
		expect(res.status).toBe(201)

		const sessionCreate = calls
			.filter((c) => c.args[0] === 'create')
			.find((c) => c.args.includes('sess-betqa2'))
		expect(sessionCreate).toBeDefined()
		// Sidecar failed → no allow@private rule, no BROWSER_CDP_URL injected.
		expect(sessionCreate?.args).not.toContain('allow@private')
		const envFlags =
			sessionCreate?.args.filter((_a, i) => sessionCreate?.args[i - 1] === '-e') ?? []
		expect(envFlags.some((e) => e.startsWith('BROWSER_CDP_URL='))).toBe(false)
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
		const { run, calls } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/usr/local/bin/msb', run } })

		const res = await app.request('/sessions/sess-stop/stop', {
			method: 'POST',
			headers: { authorization: `Bearer ${env.AGENT_SERVER_SECRET}` },
		})

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
		expect(calls.find((c) => c.args[0] === 'stop')?.args).toEqual(['stop', 'sess-stop'])
	})

	it('is idempotent — swallows a stop failure (e.g. sandbox already gone) and still returns ok', async () => {
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const run = async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'stop') throw new Error('sandbox not found')
			return { stdout: '', stderr: '' }
		}
		const app = buildApp({ env, storage: null, msb: { msbBin: '/usr/local/bin/msb', run } })

		const res = await app.request('/sessions/sess-gone/stop', {
			method: 'POST',
			headers: { authorization: `Bearer ${env.AGENT_SERVER_SECRET}` },
		})

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
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
		const { run } = makeRunner()
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
			headers: { authorization: `Bearer ${env.AGENT_SERVER_SECRET}` },
		})

		expect(res.status).toBe(200)
		expect(sessionExitCodes.get('sess-stop')).toBe(FORCED_STOP_EXIT_CODE)
	})

	it('still seeds the sentinel even when the underlying stopSandbox call fails', async () => {
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const run = async (_bin: string, args: readonly string[]) => {
			if (args[0] === 'stop') throw new Error('sandbox not found')
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
			headers: { authorization: `Bearer ${env.AGENT_SERVER_SECRET}` },
		})

		expect(res.status).toBe(200)
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
		const { run } = makeRunner()
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
				headers: { authorization: `Bearer ${env.AGENT_SERVER_SECRET}` },
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
		const { run } = makeRunner()
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
				headers: { authorization: `Bearer ${env.AGENT_SERVER_SECRET}` },
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
