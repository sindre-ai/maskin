import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

type Tool = { name: string; description?: string; input_schema?: unknown }
type Payload = { tools?: Tool[]; messages?: unknown[]; system?: unknown }

// Plain CommonJS shipped in the agent image, not part of this package.
const loaderPath = '../../../../docker/agent-base/tool-loader.js'
const { LOADER_TOOL, applyToolLoader, runLoadTool } = createRequire(import.meta.url)(
	loaderPath,
) as {
	LOADER_TOOL: string
	applyToolLoader: (
		payload: Payload,
		opts: { file: string; log: (line: string) => void },
	) => Payload
	runLoadTool: (args: unknown, file: string) => string
}
const { createProxyServer } = createRequire(import.meta.url)(
	'../../../../docker/agent-base/strip-images-proxy.js',
) as {
	createProxyServer: (
		upstream: string,
		prefs?: null,
		ttft?: { timeoutMs: number; attemptsPerProvider: number },
		toolLoader?: boolean,
	) => Server
}

const schema = { type: 'object', properties: { big: { type: 'string' } } }
const bash: Tool = { name: 'Bash', description: 'Run a shell command', input_schema: schema }
const loader: Tool = { name: LOADER_TOOL, description: 'x', input_schema: schema }
const gh: Tool = {
	name: 'mcp__github__create_branch',
	description: 'Create a branch.\nLong text follows.',
	input_schema: schema,
}
const gh2: Tool = {
	name: 'mcp__github__get_file',
	description: 'Read a file',
	input_schema: schema,
}
const maskin: Tool = {
	name: 'mcp__maskin__get_objects',
	description: 'Get objects',
	input_schema: schema,
}

function tmpFile() {
	return join(mkdtempSync(join(tmpdir(), 'tool-loader-')), 'catalog.json')
}

function request(extra: Partial<Payload> = {}): Payload {
	return {
		tools: [bash, gh, maskin, loader, gh2],
		messages: [{ role: 'user', content: 'hi' }],
		system: 'You are an agent.',
		...extra,
	}
}

function toolUse(name: string, input: unknown = {}) {
	return {
		role: 'assistant',
		content: [{ type: 'tool_use', id: 't1', name, input }],
	}
}

describe('applyToolLoader', () => {
	const run = (payload: Payload, file = tmpFile()) => {
		const lines: string[] = []
		const out = applyToolLoader(payload, { file, log: (l) => lines.push(l) })
		return { out, lines, file }
	}

	it('sends MCP tools by name only and keeps the rest', () => {
		const { out } = run(request())
		const names = (out.tools ?? []).map((t) => t.name)
		expect(names).toEqual(['Bash', LOADER_TOOL])
		expect(out.tools?.[0]).toBe(bash)
		const description = out.tools?.[1]?.description ?? ''
		expect(description).toContain('mcp__github__: create_branch, get_file')
		expect(description).toContain('mcp__maskin__: get_objects')
		expect(JSON.stringify(out.tools)).not.toContain('Read a file')
	})

	it('names the loader in the system prompt, for a string and for blocks', () => {
		expect(run(request()).out.system).toContain(LOADER_TOOL)
		const withBlocks = run(request({ system: [{ type: 'text', text: 'You are an agent.' }] })).out
		expect(withBlocks.system).toHaveLength(2)
		expect(JSON.stringify(withBlocks.system)).toContain(LOADER_TOOL)
	})

	it('adds a tool the agent asked for in full, after the fixed part', () => {
		const messages = [
			{ role: 'user', content: 'hi' },
			toolUse(LOADER_TOOL, { names: ['mcp__github__get_file', 'mcp__nothing__here'] }),
		]
		const { out } = run(request({ messages }))
		expect((out.tools ?? []).map((t) => t.name)).toEqual([
			'Bash',
			LOADER_TOOL,
			'mcp__github__get_file',
		])
		expect(out.tools?.[2]).toBe(gh2)
		// The name list does not shrink when a tool loads, so the cached start stays the same.
		expect(out.tools?.[1]?.description).toContain('create_branch, get_file')
	})

	it('keeps an MCP tool in full once the agent has called it directly', () => {
		const { out } = run(request({ messages: [toolUse('mcp__maskin__get_objects')] }))
		expect((out.tools ?? []).map((t) => t.name)).toEqual([
			'Bash',
			LOADER_TOOL,
			'mcp__maskin__get_objects',
		])
	})

	it('keeps loaded tools in the order they were asked for', () => {
		const messages = [
			toolUse(LOADER_TOOL, { names: ['mcp__maskin__get_objects'] }),
			toolUse(LOADER_TOOL, { names: ['mcp__github__create_branch'] }),
		]
		const { out } = run(request({ messages }))
		expect((out.tools ?? []).map((t) => t.name).slice(2)).toEqual([
			'mcp__maskin__get_objects',
			'mcp__github__create_branch',
		])
	})

	it('writes the catalog with one line per tool', () => {
		const { file } = run(request())
		const catalog = JSON.parse(readFileSync(file, 'utf8'))
		expect(catalog).toContainEqual({
			name: 'mcp__github__create_branch',
			description: 'Create a branch. Long text follows.',
		})
		expect(catalog).toHaveLength(3)
	})

	it('writes the catalog again when the file has gone', () => {
		const { file } = run(request())
		rmSync(file)
		run(request(), file)
		expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(3)
	})

	it('logs the tool count once, again only when it changes', () => {
		const file = tmpFile()
		const lines: string[] = []
		const log = (l: string) => lines.push(l)
		applyToolLoader(request({ tools: [bash, gh, loader, maskin] }), { file, log })
		applyToolLoader(request({ tools: [bash, gh, loader, maskin] }), { file, log })
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain('tools_before=4')
		expect(lines[0]).toContain('tools_by_name_only=2')
	})

	it('leaves the request alone when the loader is not in it', () => {
		const payload = request({ tools: [bash, gh, maskin] })
		expect(run(payload).out).toBe(payload)
	})

	it('leaves a request without tools alone', () => {
		const payload = { messages: [] }
		expect(run(payload).out).toBe(payload)
	})
})

describe('runLoadTool', () => {
	const file = tmpFile()
	writeFileSync(
		file,
		JSON.stringify([
			{ name: 'mcp__github__create_branch', description: 'Create a branch' },
			{ name: 'mcp__maskin__create_comment', description: 'Comment on an object' },
		]),
	)

	it('confirms the names it loads', () => {
		expect(runLoadTool({ names: ['mcp__github__create_branch'] }, file)).toContain(
			'Loaded: mcp__github__create_branch',
		)
	})

	it('suggests close names for one that does not exist', () => {
		const text = runLoadTool({ names: ['mcp__github__create_brnch'] }, file)
		expect(text).toContain('No tool named mcp__github__create_brnch')
	})

	it('searches names and descriptions', () => {
		const text = runLoadTool({ query: 'comment' }, file)
		expect(text).toContain('mcp__maskin__create_comment: Comment on an object')
		expect(text).not.toContain('create_branch')
	})

	it('says what to pass when given nothing', () => {
		expect(runLoadTool({}, file)).toContain('Pass names')
	})

	it('says so when no catalog exists yet', () => {
		expect(runLoadTool({ names: ['x'] }, `${file}.missing`)).toContain('No tool list')
	})
})

describe('load_tool MCP server', () => {
	it('answers initialize, tools/list and tools/call over stdio', async () => {
		const file = tmpFile()
		writeFileSync(file, JSON.stringify([{ name: 'mcp__github__create_branch', description: 'd' }]))
		const child = spawn('node', [new URL(loaderPath, import.meta.url).pathname, 'mcp'], {
			env: { ...process.env, MASKIN_TOOL_CATALOG_FILE: file },
		})
		const replies: {
			id: number
			result?: { tools?: { name: string }[]; content?: { text: string }[] }
		}[] = []
		let buffer = ''
		child.stdout.on('data', (chunk) => {
			buffer += chunk
			const lines = buffer.split('\n')
			buffer = lines.pop() ?? ''
			for (const line of lines) if (line) replies.push(JSON.parse(line))
		})
		const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
		send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
		send({ jsonrpc: '2.0', method: 'notifications/initialized' })
		send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
		send({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'load_tool', arguments: { names: ['mcp__github__create_branch'] } },
		})
		for (let i = 0; i < 50 && replies.length < 3; i++) await new Promise((r) => setTimeout(r, 100))
		child.kill()
		expect(replies.map((r) => r.id)).toEqual([1, 2, 3])
		expect(replies[1]?.result?.tools?.[0]?.name).toBe('load_tool')
		expect(replies[2]?.result?.content?.[0]?.text).toContain('Loaded: mcp__github__create_branch')
	})
})

describe('proxy with the tool loader', () => {
	const servers: Server[] = []
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
	})

	async function listen(server: Server) {
		servers.push(server)
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
		return (server.address() as AddressInfo).port
	}

	async function through(toolLoader: boolean, body: string) {
		let seen = ''
		const stub = await listen(
			createServer((req: IncomingMessage, res) => {
				const chunks: Buffer[] = []
				req.on('data', (c) => chunks.push(c))
				req.on('end', () => {
					seen = Buffer.concat(chunks).toString()
					res.end('ok')
				})
			}),
		)
		const proxy = await listen(
			createProxyServer(
				`http://127.0.0.1:${stub}`,
				null,
				{ timeoutMs: 0, attemptsPerProvider: 0 },
				toolLoader,
			),
		)
		await fetch(`http://127.0.0.1:${proxy}/v1/messages`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
		})
		return seen
	}

	it('trims the tool list when the loader is on', async () => {
		process.env.MASKIN_TOOL_CATALOG_FILE = tmpFile()
		const seen = JSON.parse(await through(true, JSON.stringify(request())))
		expect(seen.tools.map((t: Tool) => t.name)).toEqual(['Bash', LOADER_TOOL])
	})

	it('forwards the request byte for byte when the loader is off', async () => {
		const body = JSON.stringify(request())
		expect(await through(false, body)).toBe(body)
	})
})
