import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { blockedToolCalls, extensions, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GUARD_BIN, GUARD_KEY_GRACE_MS } from '../../lib/integrations/mcp-guard'
import mcpGuardRoutes from '../../routes/mcp-guard'
import { applyExtensionGuards } from '../../services/extension-guard-launch'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const WRAPPER = fileURLToPath(
	new URL('../../../../../docker/agent-base/maskin-mcp-guard.js', import.meta.url),
)
const API = 'http://localhost:3000'
const GUARD_TEST_IMAGE = process.env.GUARD_TEST_IMAGE

function guardedCommand(servers: Record<string, unknown>): string {
	return (servers['extension-fireflies'] as { command: string }).command
}

function buildApp() {
	const app = new Hono<{ Variables: { db: typeof db } }>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		await next()
	})
	app.route('/api/internal/mcp-guard', mcpGuardRoutes as never)
	return app
}

type Launched = {
	workspaceId: string
	agentId: string
	extensionId: string
	sessionId: string
	servers: Record<string, unknown>
	key: string
}

async function launch(
	agentGrants: Record<string, 'allow' | 'deny'> = {},
	sessionOverrides: Record<string, unknown> = {},
	apiUrl = API,
): Promise<Launched> {
	const workspaceId = (await insertWorkspace(db, getTestActorId())).id
	const agent = await insertActor(db, { type: 'agent' })
	const [ext] = await db
		.insert(extensions)
		.values({
			workspaceId,
			slug: 'fireflies',
			name: 'Fireflies',
			status: 'active',
			toolGrants: Object.keys(agentGrants).length ? { [agent.id]: agentGrants } : {},
		})
		.returning()
	const session = await insertSession(db, workspaceId, agent.id, getTestActorId(), sessionOverrides)
	const servers: Record<string, unknown> = {
		'extension-fireflies': {
			type: 'stdio',
			command: 'npx',
			args: ['mcp-remote', 'https://v.example'],
		},
		'integration-slack': { type: 'stdio', command: 'npx', args: ['slack-mcp'] },
	}
	await applyExtensionGuards({
		db,
		sessionId: session.id,
		workspaceId,
		agentId: agent.id,
		apiUrl,
		servers,
	})
	const env = (servers['extension-fireflies'] as { env?: Record<string, string> } | undefined)?.env
	return {
		workspaceId,
		agentId: agent.id,
		extensionId: ext.id,
		sessionId: session.id,
		servers,
		key: env?.MASKIN_GUARD_SESSION_KEY ?? '',
	}
}

function report(app: ReturnType<typeof buildApp>, key: string, body: Record<string, unknown>) {
	return app.request('/api/internal/mcp-guard/report', {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
		body: JSON.stringify(body),
	})
}

const rowsFor = (workspaceId: string) =>
	db.select().from(blockedToolCalls).where(eq(blockedToolCalls.workspaceId, workspaceId))

describe('launch rewrite (integration)', () => {
	it('starts a custom extension behind the wrapper and leaves a built-in alone', async () => {
		const l = await launch()
		const guarded = l.servers['extension-fireflies'] as { command: string; args: string[] }
		expect(guarded.command).toBe(GUARD_BIN)
		expect(guarded.args).toEqual(['--', 'npx', 'mcp-remote', 'https://v.example'])
		expect(l.servers['integration-slack']).toEqual({
			type: 'stdio',
			command: 'npx',
			args: ['slack-mcp'],
		})
	})

	it('builds the allowlist from tool_grants: no entry denies all, allow passes, deny is refused', async () => {
		const none = await launch()
		const noneEnv = (none.servers['extension-fireflies'] as { env: Record<string, string> }).env
		expect(noneEnv.MASKIN_GUARD_ALLOW).toBe('[]')
		expect(noneEnv.MASKIN_GUARD_DENY).toBe('[]')

		const l = await launch({ get_transcript: 'allow', delete_transcript: 'deny' })
		const env = (l.servers['extension-fireflies'] as { env: Record<string, string> }).env
		expect(JSON.parse(env.MASKIN_GUARD_ALLOW)).toEqual(['get_transcript'])
		expect(JSON.parse(env.MASKIN_GUARD_DENY)).toEqual(['delete_transcript'])
	})

	it('never runs a guarded server unguarded when the wrapper binary is absent', async () => {
		const l = await launch()
		const guarded = l.servers['extension-fireflies'] as { command: string; args: string[] }
		const dir = mkdtempSync(join(tmpdir(), 'guard-absent-'))
		const sentinel = join(dir, 'ran')
		try {
			// The launch config points only at the wrapper path; the real server appears
			// after "--". Swap in a missing wrapper path and a real server that would
			// leave a sentinel file if anything started it directly.
			const serverArgs = ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, '1')`]
			const result = spawnSync('/nonexistent/maskin-mcp-guard', ['--', 'node', ...serverArgs], {
				timeout: 5000,
			})
			expect(guarded.args[0]).toBe('--')
			expect(guarded.command).not.toBe('npx')
			expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT')
			expect(existsSync(sentinel)).toBe(false)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it('stores only a hash of the key on the session', async () => {
		const l = await launch()
		const [row] = await db.select().from(sessions).where(eq(sessions.id, l.sessionId))
		const stored = (row.config as { guard_keys: Record<string, string> }).guard_keys[l.extensionId]
		expect(stored).toMatch(/^[0-9a-f]{64}$/)
		expect(JSON.stringify(row.config)).not.toContain(l.key)
	})

	it('drops a custom server whose extension row is gone', async () => {
		const workspaceId = (await insertWorkspace(db, getTestActorId())).id
		const agent = await insertActor(db, { type: 'agent' })
		const session = await insertSession(db, workspaceId, agent.id, getTestActorId())
		const servers: Record<string, unknown> = {
			'extension-ghost': { type: 'stdio', command: 'npx', args: [] },
		}
		await applyExtensionGuards({
			db,
			sessionId: session.id,
			workspaceId,
			agentId: agent.id,
			apiUrl: API,
			servers,
		})
		expect(servers).toEqual({})
	})
})

describe('POST /api/internal/mcp-guard/report (integration)', () => {
	it('writes one row for a valid key, taking session, extension and agent from the key', async () => {
		const l = await launch()
		const res = await report(buildApp(), l.key, { tool_name: 'delete_transcript' })
		expect(res.status).toBe(200)
		const rows = await rowsFor(l.workspaceId)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			extensionId: l.extensionId,
			agentId: l.agentId,
			sessionId: l.sessionId,
			toolName: 'delete_transcript',
		})
	})

	it("refuses session X's key that names session Y and writes no row", async () => {
		const x = await launch()
		const y = await launch()
		const res = await report(buildApp(), x.key, { tool_name: 'put', session_id: y.sessionId })
		expect(res.status).toBe(403)
		expect(await rowsFor(x.workspaceId)).toHaveLength(0)
		expect(await rowsFor(y.workspaceId)).toHaveLength(0)
	})

	it("refuses session X's key presented with session Y's ids swapped in", async () => {
		const x = await launch()
		const y = await launch()
		const forged = x.key.replace(x.sessionId, y.sessionId)
		const res = await report(buildApp(), forged, { tool_name: 'put' })
		expect(res.status).toBe(403)
		expect(await rowsFor(y.workspaceId)).toHaveLength(0)
	})

	it('refuses a missing or unknown key', async () => {
		const l = await launch()
		expect((await report(buildApp(), '', { tool_name: 'put' })).status).toBe(403)
		expect((await report(buildApp(), 'mgk1.a.b.c', { tool_name: 'put' })).status).toBe(403)
		expect(await rowsFor(l.workspaceId)).toHaveLength(0)
	})

	it('refuses a replayed key once the session ended and the grace window has passed', async () => {
		const l = await launch()
		const endedAt = new Date(Date.now() - GUARD_KEY_GRACE_MS - 5000)
		await db
			.update(sessions)
			.set({ status: 'completed', completedAt: endedAt })
			.where(eq(sessions.id, l.sessionId))
		const res = await report(buildApp(), l.key, { tool_name: 'put' })
		expect(res.status).toBe(403)
		expect(await rowsFor(l.workspaceId)).toHaveLength(0)
	})

	it('accepts a report inside the grace window for its own session', async () => {
		const l = await launch()
		const endedAt = new Date(Date.now() - 5000)
		await db
			.update(sessions)
			.set({ status: 'completed', completedAt: endedAt })
			.where(eq(sessions.id, l.sessionId))
		const res = await report(buildApp(), l.key, { tool_name: 'put' })
		expect(res.status).toBe(200)
		expect(await rowsFor(l.workspaceId)).toHaveLength(1)
	})
})

// Real wrapper process, real launch output, real endpoint and database. This is the
// launch -> wrapper -> report -> row path. It runs on the host everywhere, and again with
// the wrapper inside the built agent-base image when GUARD_TEST_IMAGE is set (CI).
const FAKE_SERVER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
rl.on('line', (line) => {
	const msg = JSON.parse(line)
	if (msg.method === 'tools/call') {
		send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ran:' + msg.params.name }] } })
	}
})
`

describe('wrapper to endpoint round trip (integration)', () => {
	let dir: string
	let api: Server | undefined
	let child: ChildProcessWithoutNullStreams | undefined

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'guard-e2e-'))
	})
	afterEach(async () => {
		child?.kill()
		await new Promise<void>((resolve) => (api ? api.close(() => resolve()) : resolve()))
		api = undefined
		rmSync(dir, { recursive: true, force: true })
	})

	function call(proc: ChildProcessWithoutNullStreams, id: number, name: string) {
		return new Promise<{ error?: { message: string; data?: { code: string } }; result?: unknown }>(
			(resolve) => {
				let buf = ''
				const onData = (chunk: Buffer) => {
					buf += chunk.toString()
					for (const line of buf.split('\n')) {
						if (!line) continue
						const msg = JSON.parse(line)
						if (msg.id === id) {
							proc.stdout.off('data', onData)
							resolve(msg)
						}
					}
				}
				proc.stdout.on('data', onData)
				const request = {
					jsonrpc: '2.0',
					id,
					method: 'tools/call',
					params: { name, arguments: {} },
				}
				proc.stdin.write(`${JSON.stringify(request)}\n`)
			},
		)
	}

	async function roundTrip(inContainer: boolean) {
		const app = buildApp()
		api = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as unknown as Server
		await new Promise<void>((resolve) => api?.once('listening', () => resolve()))
		const port = (api.address() as { port: number }).port

		const l = await launch({}, {}, `http://127.0.0.1:${port}`)
		const serverPath = join(dir, 'fake.js')
		writeFileSync(serverPath, FAKE_SERVER)
		const guarded = l.servers['extension-fireflies'] as {
			args: string[]
			env: Record<string, string>
		}
		expect(guarded.args[0]).toBe('--')
		if (inContainer) {
			// The wrapper as installed in the agent-base image built from this branch
			// (GUARD_TEST_IMAGE), at the binary path the launch rewrite points at, with the
			// env the launch produced. Host networking reaches the API listening above.
			const envFlags = Object.entries(guarded.env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
			child = spawn(
				'docker',
				[
					...['run', '-i', '--rm', '--network', 'host', '-v', `${dir}:/fake:ro`, ...envFlags],
					...['--entrypoint', guardedCommand(l.servers), GUARD_TEST_IMAGE as string],
					...['--', 'node', '/fake/fake.js'],
				],
				{ env: process.env },
			)
		} else {
			// Same wrapper, same env and args the launch produced; only the binary path and the
			// real server (a stub that answers any tools/call) differ.
			child = spawn('node', [WRAPPER, '--', 'node', serverPath], {
				env: { ...process.env, ...guarded.env },
			})
		}

		const denied = await call(child, 1, 'delete_transcript')
		expect(denied.error?.message).toBe('ACL: tool not granted')
		expect(denied.error?.data?.code).toBe('forbidden')

		let rows = await rowsFor(l.workspaceId)
		for (let i = 0; i < 50 && rows.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 100))
			rows = await rowsFor(l.workspaceId)
		}
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ toolName: 'delete_transcript', sessionId: l.sessionId })
	}

	it(
		'an agent with no grant calling a write tool gets forbidden and exactly one row exists',
		() => roundTrip(false),
		20_000,
	)

	// The real-container check. Runs only where an image built from this branch is named in
	// GUARD_TEST_IMAGE (the integration-tests job in CI builds it); skipped elsewhere.
	it.skipIf(!GUARD_TEST_IMAGE)(
		'the same round trip holds with the wrapper running inside the agent-base image',
		() => roundTrip(true),
		60_000,
	)
})
