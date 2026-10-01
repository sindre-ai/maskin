// Handler test for POST /sessions/:sessionId/push-agent-files (§7.1).
//
// The route landed with Commit 2 (apps/agent-server/src/index.ts). It reads
// `${AGENT_SESSION_ROOT}/<id>/{learnings,memory}/` from the agent-server host
// and uploads each file under `<keyPrefix>/<dir>/<entry>` through the storage
// provider. These cells drive the real handler through buildApp with a stubbed
// storage provider (no S3) and a stubbed msb runner.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StorageProvider } from '@maskin/storage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../index'
import type { AgentServerEnv } from '../lib/env'

// Inline mirrors of the §6.4 shared types so this file does NOT force an
// `@maskin/shared` dep on the agent-server package boundary just for a test.
// See the parallel note in session-stop.test.ts.
type AgentPushDirectory = 'learnings' | 'memory'
const AGENT_PUSH_DIRECTORIES: readonly AgentPushDirectory[] = ['learnings', 'memory']
interface PushAgentFilesRequest {
	directories: readonly AgentPushDirectory[]
	keyPrefix: string
}
interface PushAgentFilesError {
	dir: AgentPushDirectory | string
	message: string
}
interface PushAgentFilesResponse {
	pushed: { [K in AgentPushDirectory]?: { files: number; bytes: number } }
	errors: PushAgentFilesError[]
}

function makeEnv(overrides: Partial<AgentServerEnv> = {}): AgentServerEnv {
	return {
		PORT: 3001,
		METRICS_PORT: 0,
		AGENT_SERVER_STALL_THRESHOLD_MS: 300_000,
		AGENT_SERVER_SECRET: 'test-secret-thirty-two-chars-long',
		MSB_BIN: '/usr/local/bin/msb',
		AGENT_SESSION_ROOT: '/tmp/agent-server-push-files-test',
		S3_REGION: 'us-east-1',
		WARM_POOL_REFRESH_MINUTES: 0,
		BROWSER_SIDECAR_IMAGE: 'browser-sidecar:latest',
		AGENT_SERVER_SSH_KEY_PATH: '/tmp/agent-server-push-files-test/ssh/relay_key',
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
		if (args[0] === 'list') return { stdout: '[]', stderr: '' }
		return { stdout: '', stderr: '' }
	}
	return { run, calls }
}

let sessionRoot: string
beforeEach(() => {
	sessionRoot = mkdtempSync(join(tmpdir(), 'agent-server-push-files-'))
})
afterEach(async () => {
	await rm(sessionRoot, { recursive: true, force: true })
})

describe('POST /sessions/:sessionId/push-agent-files — §7.1 shared types', () => {
	it('AGENT_PUSH_DIRECTORIES holds the two dirs the RPC pushes', () => {
		expect(AGENT_PUSH_DIRECTORIES).toEqual(['learnings', 'memory'])
	})

	it('shared types compile against §6.4', () => {
		const dir: AgentPushDirectory = 'learnings'
		const req: PushAgentFilesRequest = {
			directories: ['learnings', 'memory'],
			keyPrefix: 'agents/ws-1/actor-1',
		}
		const res: PushAgentFilesResponse = {
			pushed: { learnings: { files: 2, bytes: 64 } },
			errors: [] as PushAgentFilesError[],
		}
		expect(dir).toBe('learnings')
		expect(req.directories).toContain('memory')
		expect(res.pushed.learnings?.bytes).toBe(64)
	})
})

const KEY_PREFIX = 'agents/ws-1/actor-1'

function makeStorage(overrides: { failKey?: (key: string) => boolean } = {}) {
	const puts: Array<{ key: string; data: Buffer }> = []
	const storage = {
		put: async (key: string, data: Buffer | Uint8Array) => {
			if (overrides.failKey?.(key)) throw new Error(`storage put failed: ${key}`)
			puts.push({ key, data: Buffer.from(data) })
		},
	} as unknown as StorageProvider
	return { storage, puts }
}

function seedFile(sessionId: string, dir: AgentPushDirectory, name: string, body: string) {
	const d = join(sessionRoot, sessionId, dir)
	mkdirSync(d, { recursive: true })
	writeFileSync(join(d, name), body)
}

function setup(storage: StorageProvider | null) {
	const { run } = makeRunner()
	const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
	const app = buildApp({ env, storage, msb: { msbBin: '/x', run } })
	const post = (sessionId: string, body: unknown, auth = true) =>
		app.request(`/sessions/${sessionId}/push-agent-files`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(auth ? { authorization: `Bearer ${env.AGENT_SERVER_SECRET}` } : {}),
			},
			body: typeof body === 'string' ? body : JSON.stringify(body),
		})
	return { post }
}

describe('POST /sessions/:sessionId/push-agent-files — handler', () => {
	it('rejects a request without bearer auth with 401', async () => {
		const { post } = setup(makeStorage().storage)
		const res = await post('sess-1', { directories: ['learnings'], keyPrefix: KEY_PREFIX }, false)
		expect(res.status).toBe(401)
	})

	it('rejects a malformed session id with 400', async () => {
		const { post } = setup(makeStorage().storage)
		const res = await post('..%2Fetc%2Fpasswd', {
			directories: ['learnings'],
			keyPrefix: KEY_PREFIX,
		})
		expect(res.status).toBe(400)
	})

	it('returns 503 storage_unavailable when the agent-server has no storage provider', async () => {
		const { post } = setup(null)
		const res = await post('sess-1', { directories: ['learnings'], keyPrefix: KEY_PREFIX })
		expect(res.status).toBe(503)
		expect(await res.json()).toEqual({ error: 'storage_unavailable' })
	})

	it('rejects a non-JSON body with 400 invalid_json', async () => {
		const { post } = setup(makeStorage().storage)
		const res = await post('sess-1', 'not json')
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({ error: 'invalid_json' })
	})

	it.each([
		['empty directories', { directories: [], keyPrefix: KEY_PREFIX }],
		['unknown directory', { directories: ['secrets'], keyPrefix: KEY_PREFIX }],
		['keyPrefix outside agents/<id>/<id>', { directories: ['learnings'], keyPrefix: '../etc' }],
		['missing keyPrefix', { directories: ['learnings'] }],
	])('rejects %s with 400 invalid_request', async (_label, body) => {
		const { post } = setup(makeStorage().storage)
		const res = await post('sess-1', body)
		expect(res.status).toBe(400)
		expect(((await res.json()) as { error: string }).error).toBe('invalid_request')
	})

	it('uploads every file in both dirs under <keyPrefix>/<dir>/<entry> and reports counts', async () => {
		seedFile('sess-1', 'learnings', 'a.md', 'hello')
		seedFile('sess-1', 'learnings', 'b.md', 'world!')
		seedFile('sess-1', 'memory', 'm.json', '{}')
		const { storage, puts } = makeStorage()
		const { post } = setup(storage)
		const res = await post('sess-1', {
			directories: ['learnings', 'memory'],
			keyPrefix: KEY_PREFIX,
		})
		expect(res.status).toBe(200)
		expect((await res.json()) as PushAgentFilesResponse).toEqual({
			pushed: { learnings: { files: 2, bytes: 11 }, memory: { files: 1, bytes: 2 } },
			errors: [],
		})
		expect(puts.map((p) => p.key).sort()).toEqual([
			`${KEY_PREFIX}/learnings/a.md`,
			`${KEY_PREFIX}/learnings/b.md`,
			`${KEY_PREFIX}/memory/m.json`,
		])
		expect(puts.find((p) => p.key.endsWith('a.md'))?.data.toString()).toBe('hello')
	})

	it('tolerates missing directories: zero-file entry, no error, no upload', async () => {
		const { storage, puts } = makeStorage()
		const { post } = setup(storage)
		const res = await post('sess-never-wrote', {
			directories: ['learnings', 'memory'],
			keyPrefix: KEY_PREFIX,
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			pushed: { learnings: { files: 0, bytes: 0 }, memory: { files: 0, bytes: 0 } },
			errors: [],
		})
		expect(puts).toEqual([])
	})

	it('records a per-dir error without aborting the other directory', async () => {
		seedFile('sess-1', 'learnings', 'a.md', 'hello')
		seedFile('sess-1', 'memory', 'm.json', '{}')
		const { storage, puts } = makeStorage({ failKey: (k) => k.includes('/learnings/') })
		const { post } = setup(storage)
		const res = await post('sess-1', {
			directories: ['learnings', 'memory'],
			keyPrefix: KEY_PREFIX,
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as PushAgentFilesResponse
		expect(body.errors).toHaveLength(1)
		expect(body.errors[0]?.dir).toBe('learnings')
		expect(body.errors[0]?.message).toContain('storage put failed')
		expect(body.pushed.memory).toEqual({ files: 1, bytes: 2 })
		expect(puts.map((p) => p.key)).toEqual([`${KEY_PREFIX}/memory/m.json`])
	})
})
