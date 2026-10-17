import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Config = {
	allow: Set<string>
	deny: Set<string>
	reportUrl: string
	sessionKey: string
}
type LineResult = {
	forward: string | null
	replies: { id: unknown; error?: { code: number; message: string; data: { code: string } } }[]
	denied: string[]
}

const GUARD_PATH = fileURLToPath(
	new URL('../../../../docker/agent-base/maskin-mcp-guard.js', import.meta.url),
)

// The wrapper is plain CommonJS shipped in the agent image, not part of this package.
const { VERSION, FORBIDDEN_MESSAGE, loadConfig, isAllowed, processLine, reportDenial } =
	createRequire(import.meta.url)(GUARD_PATH) as {
		VERSION: string
		FORBIDDEN_MESSAGE: string
		loadConfig: (env: Record<string, string | undefined>) => Config
		isAllowed: (config: Config, toolName: unknown) => boolean
		processLine: (config: Config, line: string) => LineResult
		reportDenial: (config: Config, toolName: string, fetchImpl?: typeof fetch) => Promise<boolean>
	}

const call = (id: number, name: string) =>
	JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })

describe('guard decisions', () => {
	it('denies and reports every tool when the agent has no grant', async () => {
		const config = loadConfig({
			MASKIN_GUARD_REPORT_URL: 'https://api.test/guard/blocked',
			MASKIN_GUARD_SESSION_KEY: 'gk_secret',
		})
		const result = processLine(config, call(7, 'create_issue'))
		expect(result.forward).toBeNull()
		expect(result.denied).toEqual(['create_issue'])
		expect(result.replies).toHaveLength(1)
		expect(result.replies[0]?.id).toBe(7)
		expect(result.replies[0]?.error?.message).toBe(FORBIDDEN_MESSAGE)
		expect(result.replies[0]?.error?.data.code).toBe('forbidden')

		const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 })
		await expect(reportDenial(config, 'create_issue', fetchImpl)).resolves.toBe(true)
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://api.test/guard/blocked')
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer gk_secret')
		// Session and extension come from the key, so the body names only the tool.
		expect(JSON.parse(init.body as string)).toEqual({ tool_name: 'create_issue' })
	})

	it('passes an allowed tool through untouched', () => {
		const config = loadConfig({ MASKIN_GUARD_ALLOW: JSON.stringify(['list_issues']) })
		const line = call(1, 'list_issues')
		const result = processLine(config, line)
		expect(result).toEqual({ forward: line, replies: [], denied: [] })
	})

	it('denies and reports an explicitly denied tool even if it is also allowed', () => {
		const config = loadConfig({
			MASKIN_GUARD_ALLOW: JSON.stringify(['list_issues', 'delete_issue']),
			MASKIN_GUARD_DENY: JSON.stringify(['delete_issue']),
		})
		const result = processLine(config, call(2, 'delete_issue'))
		expect(result.forward).toBeNull()
		expect(result.denied).toEqual(['delete_issue'])
		expect(result.replies[0]?.error?.message).toBe(FORBIDDEN_MESSAGE)
	})

	it('treats an unreadable allowlist as no grant', () => {
		const config = loadConfig({ MASKIN_GUARD_ALLOW: '{not json' })
		expect(isAllowed(config, 'list_issues')).toBe(false)
	})

	it('never filters anything but tools/call', () => {
		const config = loadConfig({})
		for (const method of ['initialize', 'tools/list', 'resources/read', 'ping']) {
			const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method })
			expect(processLine(config, line).forward).toBe(line)
		}
	})

	it('refuses a call with no usable tool name and a line it cannot parse', () => {
		const config = loadConfig({ MASKIN_GUARD_ALLOW: JSON.stringify(['list_issues']) })
		const noName = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} })
		expect(processLine(config, noName).forward).toBeNull()
		const garbage = processLine(config, '{"method":"tools/call"')
		expect(garbage.forward).toBeNull()
		expect(garbage.replies[0]?.error?.code).toBe(-32700)
	})

	it('answers a denied call inside a batch and forwards the rest', () => {
		const config = loadConfig({ MASKIN_GUARD_ALLOW: JSON.stringify(['list_issues']) })
		const ok = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_issues' } }
		const bad = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_issue' } }
		const result = processLine(config, JSON.stringify([ok, bad]))
		expect(JSON.parse(result.forward as string)).toEqual([ok])
		expect(result.replies.map((r) => r.id)).toEqual([2])
		expect(result.denied).toEqual(['create_issue'])
	})
})

describe('reporting failures', () => {
	it('returns false instead of throwing when the API is down', async () => {
		const config = loadConfig({
			MASKIN_GUARD_REPORT_URL: 'https://api.test/x',
			MASKIN_GUARD_SESSION_KEY: 'gk',
		})
		const fetchImpl = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		await expect(reportDenial(config, 't', fetchImpl)).resolves.toBe(false)
		errors.mockRestore()
	})

	it('does not call the API when no report url or key is configured', async () => {
		const fetchImpl = vi.fn()
		await expect(reportDenial(loadConfig({}), 't', fetchImpl)).resolves.toBe(false)
		expect(fetchImpl).not.toHaveBeenCalled()
	})
})

describe('--version', () => {
	it('prints the wrapper name and version', () => {
		const out = execFileSync('node', [GUARD_PATH, '--version'], { encoding: 'utf8' })
		expect(out.trim()).toBe(`maskin-mcp-guard ${VERSION}`)
	})
})

// Stdio smoke: a fake MCP server behind the real wrapper process.
const FAKE_SERVER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
rl.on('line', (line) => {
	const msg = JSON.parse(line)
	if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
	else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'list_issues' }, { name: 'create_issue' }] } })
	else if (msg.method === 'tools/call') {
		const leaked = Object.keys(process.env).some((k) => k.startsWith('MASKIN_GUARD_'))
		send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ran:' + msg.params.name + ':leak=' + leaked }] } })
	}
})
`

type Rpc = {
	id?: number
	result?: unknown
	error?: { code: number; message: string; data: unknown }
}

describe('stdio smoke', () => {
	let dir: string
	let api: Server | undefined
	let guard: ChildProcessWithoutNullStreams | undefined

	afterEach(async () => {
		guard?.kill()
		await new Promise<void>((resolve) => (api ? api.close(() => resolve()) : resolve()))
		api = undefined
		rmSync(dir, { recursive: true, force: true })
	})

	async function start(env: Record<string, string>) {
		dir = mkdtempSync(join(tmpdir(), 'guard-smoke-'))
		const serverPath = join(dir, 'fake-mcp-server.js')
		writeFileSync(serverPath, FAKE_SERVER)

		const reports: { auth: string | undefined; body: unknown }[] = []
		api = createServer((req: IncomingMessage, res) => {
			const chunks: Buffer[] = []
			req.on('data', (c) => chunks.push(c))
			req.on('end', () => {
				reports.push({
					auth: req.headers.authorization,
					body: JSON.parse(Buffer.concat(chunks).toString()),
				})
				res.writeHead(204).end()
			})
		})
		await new Promise<void>((resolve) => api?.listen(0, '127.0.0.1', resolve))
		const reportUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/report`

		guard = spawn('node', [GUARD_PATH, '--', 'node', serverPath], {
			env: {
				...process.env,
				MASKIN_GUARD_REPORT_URL: reportUrl,
				MASKIN_GUARD_SESSION_KEY: 'gk_smoke',
				...env,
			},
		})
		const lines: Rpc[] = []
		const waiters: (() => void)[] = []
		let buffer = ''
		guard.stdout.setEncoding('utf8')
		guard.stdout.on('data', (chunk: string) => {
			buffer += chunk
			let i = buffer.indexOf('\n')
			while (i !== -1) {
				lines.push(JSON.parse(buffer.slice(0, i)))
				buffer = buffer.slice(i + 1)
				i = buffer.indexOf('\n')
			}
			for (const w of waiters.splice(0)) w()
		})
		const request = async (id: number, method: string, params?: unknown): Promise<Rpc> => {
			guard?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
			for (;;) {
				const hit = lines.find((l) => l.id === id)
				if (hit) return hit
				await new Promise<void>((resolve) => waiters.push(resolve))
			}
		}
		return { request, reports }
	}

	it('passes tools/list unfiltered, refuses an ungranted call, passes a granted one', async () => {
		const { request, reports } = await start({
			MASKIN_GUARD_ALLOW: JSON.stringify(['list_issues']),
		})

		const init = await request(1, 'initialize', {})
		expect(init.result).toMatchObject({ serverInfo: { name: 'fake' } })

		const list = await request(2, 'tools/list')
		expect((list.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual([
			'list_issues',
			'create_issue',
		])

		const refused = await request(3, 'tools/call', { name: 'create_issue', arguments: {} })
		expect(refused.result).toBeUndefined()
		expect(refused.error?.message).toBe('ACL: tool not granted')
		expect(refused.error?.data).toMatchObject({ code: 'forbidden' })

		const granted = await request(4, 'tools/call', { name: 'list_issues', arguments: {} })
		// The wrapper's own env (session key included) must not reach the vendor server.
		expect(granted.result).toEqual({
			content: [{ type: 'text', text: 'ran:list_issues:leak=false' }],
		})

		await vi.waitFor(() => expect(reports).toHaveLength(1))
		expect(reports[0]).toEqual({ auth: 'Bearer gk_smoke', body: { tool_name: 'create_issue' } })
	})

	it('refuses every call when launched with no grant', async () => {
		const { request, reports } = await start({})
		const refused = await request(1, 'tools/call', { name: 'list_issues', arguments: {} })
		expect(refused.error?.message).toBe('ACL: tool not granted')
		await vi.waitFor(() => expect(reports).toHaveLength(1))
	})
})
