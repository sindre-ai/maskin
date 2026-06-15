import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../index'
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

		const skel = await readdir(join(sessionRoot, 'sess-happy'))
		expect(skel.sort()).toEqual(['learnings', 'memory', 'skills', 'workspace'])
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
		expect(sessionCreate?.args[pullIdx + 1]).toBe('missing')
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
