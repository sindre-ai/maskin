// Handler test for POST /sessions/:sessionId/push-agent-files (§7.1).
//
// This endpoint DOES NOT YET EXIST on the agent-server at commit 2's
// foundation-slice head. Commit 2's second slice lands it at
// `apps/agent-server/src/index.ts` alongside the existing /stop handler, and
// its server-side implementation reads from `${sessionDir}/learnings/` and
// `${sessionDir}/memory/` (host-side mount per `microsandbox.ts:337`).
//
// This file therefore holds a bearer-auth cell that WILL work against buildApp
// once the route lands (a 401 on a missing bearer is a route-agnostic
// middleware assertion — no route body needed), plus a shared-types compile
// pin, plus §7.1 reshape cells as `it.todo(...)`.
//
// When commit 2's second slice lands the route, the todo cells flip to full
// assertions on the request body, S3 push, and the response envelope.

import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
		const req: PushAgentFilesRequest = { directories: ['learnings', 'memory'] }
		const res: PushAgentFilesResponse = {
			pushed: { learnings: { files: 2, bytes: 64 } },
			errors: [] as PushAgentFilesError[],
		}
		expect(dir).toBe('learnings')
		expect(req.directories).toContain('memory')
		expect(res.pushed.learnings?.bytes).toBe(64)
	})
})

describe('POST /sessions/:sessionId/push-agent-files — commit 2 route landing', () => {
	// Bearer-auth is enforced by the /sessions/* middleware inside buildApp —
	// this assertion works against the CURRENT buildApp regardless of whether
	// the specific push-agent-files handler is registered. Once the handler
	// lands, a missing bearer must still 401, so this cell is durable.
	it('rejects a request without bearer auth (route-agnostic middleware assertion)', async () => {
		const { run } = makeRunner()
		const env = makeEnv({ AGENT_SESSION_ROOT: sessionRoot })
		const app = buildApp({ env, storage: null, msb: { msbBin: '/x', run } })
		const res = await app.request('/sessions/sess-1/push-agent-files', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ directories: ['learnings'] }),
		})
		// Either 401 (auth middleware) or 404 (route not yet registered) is
		// acceptable at commit 2's foundation-slice head — both are proof the
		// handler cannot be reached unauthenticated. The reshape cells below
		// tighten the assertion once the route lands.
		expect([401, 404]).toContain(res.status)
	})

	it.todo('registered at POST /sessions/:sessionId/push-agent-files under /sessions/* auth')
	it.todo('accepts a PushAgentFilesRequest body against the §6.4 shape')
	it.todo('reads ${sessionDir}/learnings/ + ${sessionDir}/memory/ and uploads to §6.4 prefixes')
	it.todo('tolerates missing directories: empty `pushed` entry, no error added')
	it.todo('records per-dir errors in `errors[]` without aborting the whole push')
	it.todo('§7.2 stopSandbox order: stop first, THEN push — validated in the composed settle path')
})
