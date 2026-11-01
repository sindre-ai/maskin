import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
	READ_ONLY_ALLOWLIST,
	ReadOnlyViolation,
	assertReadOnly,
	classifySchemaProbe,
	createClient,
	exitCodeFor,
	formatJson,
	formatTable,
	heroCardBytes,
	main,
	walkEvents,
} from './mcp-baseline.mjs'

const SCRIPT = fileURLToPath(new URL('./mcp-baseline.mjs', import.meta.url))
const KEY = 'sk-test-secret-key-0123456789'
const WORKSPACE = '11111111-1111-4111-8111-111111111111'

const ok = (obj) => ({
	content: [{ type: 'text', text: JSON.stringify(obj) }],
	structuredContent: obj,
})

function toolResult(name, args, opts) {
	switch (name) {
		case 'list_workspaces':
			return ok({
				heroCard: { kind: 'list', objects: [{ id: WORKSPACE }] },
				page: { total: 2 },
				workspaces: [{ id: WORKSPACE }, { id: 'w2' }],
			})
		case 'list_actors':
			return {
				structuredContent: {
					heroCard: {
						kind: 'list',
						objects: [
							{ id: 'a1', description: 'one' },
							{ id: 'a2', description: 'two' },
							{ id: 'a3', description: 'three' },
							{ id: 'a4', description: 'four' },
							{ id: 'a5', description: null },
						],
					},
				},
			}
		case 'get_actor':
			return ok({ id: args.id, system_prompt: 'SECRET PROMPT TEXT' })
		case 'list_sessions':
			return ok({ sessions: args.verbose ? [{ id: 's', config: {}, cost: 1 }] : [{ id: 's' }] })
		case 'get_events': {
			const page = args.cursor ? Number(args.cursor) : 0
			const total = opts.eventPages ?? 3
			const events = Array.from({ length: Math.min(args.limit ?? 100, 100) }, (_, i) => ({
				id: `e${page}-${i}`,
			}))
			const more = args.limit === 100 && page + 1 < total
			return ok({ events, ...(more ? { next_cursor: String(page + 1) } : {}) })
		}
		case 'get_workspace_schema':
			return opts.schemaBug
				? ok({ workspace: 'someone else', types: [] })
				: {
						isError: true,
						content: [{ type: 'text', text: `Workspace ${args.workspace_id} not found` }],
					}
		default:
			throw new Error(`stub: unexpected tool ${name}`)
	}
}

async function startStub(opts = {}) {
	const seen = { methods: [], tools: [], headers: [], rateLimitedOnce: false }
	const server = createServer((req, res) => {
		let raw = ''
		req.on('data', (c) => {
			raw += c
		})
		req.on('end', () => {
			seen.headers.push(req.headers)
			if (opts.rateLimitOnce && !seen.rateLimitedOnce) {
				seen.rateLimitedOnce = true
				res.writeHead(429, { 'retry-after': '0' })
				res.end('slow down')
				return
			}
			if (opts.fail500) {
				res.writeHead(500, { 'content-type': 'text/plain' })
				res.end(`boom, you sent ${req.headers.authorization}`)
				return
			}
			const msg = JSON.parse(raw)
			seen.methods.push(msg.method)
			let result
			if (msg.method === 'initialize') {
				result = { serverInfo: { name: 'stub', version: '9.9.9' } }
			} else if (msg.method === 'tools/list') {
				const names = READ_ONLY_ALLOWLIST.filter((n) => n !== 'tools/list').filter(
					(n) => n !== opts.missingTool,
				)
				result = {
					tools: [
						...names.map((name) => ({
							name,
							description: 'x'.repeat(10),
							annotations: { readOnlyHint: true },
						})),
						{ name: 'create_objects', description: 'y'.repeat(3000), title: 'Create' },
					],
				}
			} else if (msg.method === 'tools/call') {
				seen.tools.push(msg.params.name)
				result = toolResult(msg.params.name, msg.params.arguments, opts)
			}
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
		})
	})
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	const url = `http://127.0.0.1:${server.address().port}/mcp`
	return { url, seen, close: () => new Promise((r) => server.close(r)) }
}

const envFor = (url, extra = {}) => ({
	MASKIN_MCP_URL: url,
	MASKIN_API_KEY: KEY,
	MASKIN_WORKSPACE_ID: WORKSPACE,
	...extra,
})

async function runMain(url, argv, extraEnv, deps = {}) {
	let stdout = ''
	let stderr = ''
	const code = await main(argv, envFor(url, extraEnv), {
		stdout: (s) => {
			stdout += s
		},
		stderr: (s) => {
			stderr += s
		},
		deps: { randomUuid: () => '22222222-2222-4222-8222-222222222222', ...deps },
	})
	return { code, stdout, stderr }
}

const withoutTiming = (json) => {
	const { timing, ...rest } = JSON.parse(json)
	return rest
}

test('two runs give identical --json except timing', async () => {
	const stub = await startStub()
	try {
		const a = await runMain(stub.url, ['--json'], {})
		const b = await runMain(stub.url, ['--json'], {})
		assert.equal(a.code, 0, a.stderr)
		assert.equal(b.code, 0, b.stderr)
		assert.deepEqual(withoutTiming(a.stdout), withoutTiming(b.stdout))
	} finally {
		await stub.close()
	}
})

test('write tool names throw before any call and map to exit code 2', async () => {
	for (const name of [
		'create_objects',
		'update_objects',
		'delete_object',
		'run_agent',
		'tools/call',
	]) {
		assert.throws(() => assertReadOnly(name), ReadOnlyViolation)
	}
	for (const name of READ_ONLY_ALLOWLIST) assert.doesNotThrow(() => assertReadOnly(name))
	assert.equal(exitCodeFor(new ReadOnlyViolation('create_objects')), 2)
	assert.equal(exitCodeFor(new Error('anything else')), 1)

	const stub = await startStub()
	try {
		const client = createClient({ url: stub.url, apiKey: KEY, workspaceId: WORKSPACE })
		assert.throws(() => client.callTool('create_objects', {}), ReadOnlyViolation)
		assert.deepEqual(stub.seen.tools, [], 'nothing reached the server')
	} finally {
		await stub.close()
	}
})

test('table and --json carry every measure, and the key never appears', async () => {
	const stub = await startStub()
	try {
		const json = await runMain(stub.url, ['--json'], {})
		const table = await runMain(stub.url, [], {})
		const report = JSON.parse(json.stdout)
		for (const k of ['meta', 'tools_list', 'workspaces', 'calls', 'events_walk', 'schema_probe']) {
			assert.ok(k in report, `json has ${k}`)
		}
		assert.equal(report.tools_list.tool_count, 7)
		assert.equal(report.tools_list.descriptions_over_limit, 1)
		assert.equal(report.tools_list.with_title, 1)
		assert.equal(report.workspaces.count, 2)
		assert.equal(report.meta.actors_pinned, false)
		assert.equal(report.schema_probe, 'errors-and-names-the-id')
		assert.deepEqual(Object.keys(report.calls).filter((k) => k.startsWith('get_actor_')).length, 4)
		for (const needle of [
			'tools/list bytes',
			'list_workspaces',
			'get_events',
			'heroCard',
			'UNPINNED',
		]) {
			assert.ok(table.stdout.includes(needle), `table mentions ${needle}`)
		}
		assert.ok(table.stdout.includes('65'), 'audit figure shown beside the new one')
		for (const text of [json.stdout, table.stdout, json.stderr, table.stderr]) {
			assert.ok(!text.includes(KEY))
			assert.ok(!text.includes('SECRET PROMPT TEXT'), 'response bodies are never printed')
		}
	} finally {
		await stub.close()
	}
})

test('a server error that echoes the key does not leak it', async () => {
	const stub = await startStub({ fail500: true })
	try {
		const r = await runMain(stub.url, [], {})
		assert.equal(r.code, 1)
		assert.ok(!r.stderr.includes(KEY))
		assert.ok(!r.stderr.includes('boom'), 'the body is not echoed')
	} finally {
		await stub.close()
	}
})

test('a 429 is retried once and recorded', async () => {
	const stub = await startStub({ rateLimitOnce: true })
	try {
		const r = await runMain(stub.url, ['--json'], {}, { sleep: async () => {} })
		assert.equal(r.code, 0, r.stderr)
		assert.equal(JSON.parse(r.stdout).meta.rate_limited, true)
	} finally {
		await stub.close()
	}
})

test('a 429 that repeats fails the run', async () => {
	const server = createServer((_req, res) => {
		res.writeHead(429, { 'retry-after': '0' })
		res.end()
	})
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	try {
		const url = `http://127.0.0.1:${server.address().port}/mcp`
		const r = await runMain(url, [], {}, { sleep: async () => {} })
		assert.equal(r.code, 1)
		assert.match(r.stderr, /429/)
	} finally {
		await new Promise((r) => server.close(r))
	}
})

test('requests send both Accept types and the key as a bearer token', async () => {
	const stub = await startStub()
	try {
		await runMain(stub.url, ['--json'], {})
		assert.equal(stub.seen.methods[0], 'initialize')
		for (const h of stub.seen.headers) {
			assert.equal(h.accept, 'application/json, text/event-stream')
			assert.equal(h.authorization, `Bearer ${KEY}`)
			assert.equal(h['mcp-session-id'], undefined)
		}
		for (const name of stub.seen.tools) assert.ok(READ_ONLY_ALLOWLIST.includes(name))
	} finally {
		await stub.close()
	}
})

test('an allowlisted tool missing from tools/list fails loudly', async () => {
	const stub = await startStub({ missingTool: 'get_events' })
	try {
		const r = await runMain(stub.url, [], {})
		assert.equal(r.code, 1)
		assert.match(r.stderr, /missing from tools\/list: get_events/)
		assert.deepEqual(stub.seen.tools, [])
	} finally {
		await stub.close()
	}
})

test('the paging walk stops at the page cap and counts distinct ids', async () => {
	const fetchPage = async ({ limit, cursor }) => {
		const n = cursor ? Number(cursor) : 0
		const events = Array.from({ length: limit === 100 ? 100 : limit }, (_, i) => ({
			id: limit === 100 ? `e${n}-${i % 90}` : `x${i}`,
		}))
		return ok({ events, ...(limit === 100 ? { next_cursor: String(n + 1) } : {}) })
	}
	const walk = await walkEvents(fetchPage, { pageCap: 4 })
	assert.equal(walk.pages, 4)
	assert.equal(walk.stopped_by, 'page_cap')
	assert.equal(walk.distinct_event_ids, 4 * 90)

	const short = await walkEvents(async ({ limit }) =>
		ok({ events: [{ id: 'a' }, { id: 'a' }].slice(0, limit) }),
	)
	assert.equal(short.stopped_by, 'end')
	assert.equal(short.distinct_event_ids, 1)
})

test('schema probe classification', () => {
	const id = '33333333-3333-4333-8333-333333333333'
	assert.equal(
		classifySchemaProbe({ isError: true, content: [{ type: 'text', text: `no ${id}` }] }, id),
		'errors-and-names-the-id',
	)
	assert.equal(
		classifySchemaProbe({ isError: true, content: [{ type: 'text', text: 'nope' }] }, id),
		'other',
	)
	assert.equal(classifySchemaProbe(ok({ workspace: 'x' }), id), 'returns-another-workspace')
})

test('heroCard size is read from content[0].text and is 0 when absent', () => {
	assert.equal(heroCardBytes({ content: [{ type: 'text', text: '{"a":1}' }] }), 0)
	assert.equal(heroCardBytes({ content: [{ type: 'text', text: 'not json' }] }), 0)
	assert.equal(heroCardBytes({ content: [{ type: 'text', text: '{"heroCard":{"k":1}}' }] }), 7)
})

test('formatters are pure functions of the report', async () => {
	const stub = await startStub()
	try {
		const r = await runMain(stub.url, ['--json'], {})
		const report = JSON.parse(r.stdout)
		assert.equal(formatJson(report), r.stdout)
		assert.equal(formatTable(report), formatTable(report))
	} finally {
		await stub.close()
	}
})

test('invoked directly, a missing key exits 1 without printing the environment', async () => {
	const child = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH } })
	let stderr = ''
	child.stderr.on('data', (d) => {
		stderr += d
	})
	const code = await new Promise((r) => child.on('close', r))
	assert.equal(code, 1)
	assert.match(stderr, /MASKIN_API_KEY is not set/)
})
