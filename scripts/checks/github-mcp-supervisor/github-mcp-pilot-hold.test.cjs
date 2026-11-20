// Tests for the pilot hold in docker/agent-base/github-mcp-supervisor.cjs, run with the Node test
// runner (CI: the unit-tests job). A fake github-mcp-server answers tools/list and tool calls, and
// a fake Maskin check endpoint stands in for POST /api/pilot-gate/check. No Docker needed.
//
// The relay reads which tools are read-only from the real tools/list. A tool that list does not
// mark read-only is a write, and every write asks Maskin first.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { PassThrough } = require('node:stream')

const { createSupervisor } = require('../../../docker/agent-base/github-mcp-supervisor.cjs')

const FAKE_SERVER = path.join(__dirname, 'fake-github-mcp-server.cjs')
const API_KEY = 'fake-maskin-api-key-5555'
const SESSION_ID = '11111111-2222-4333-8444-555555555555'
const WORKSPACE_ID = 'fake-workspace-6666'
const PILOT = 'This flow is in pilot, so sends wait for a person'

function splitLines(onLine) {
	let buffered = ''
	return (chunk) => {
		buffered += chunk.toString('utf8')
		let index = buffered.indexOf('\n')
		while (index !== -1) {
			const line = buffered.slice(0, index)
			buffered = buffered.slice(index + 1)
			if (line.length > 0) onLine(line)
			index = buffered.indexOf('\n')
		}
	}
}

// answer(call) returns { status, body } for each check the relay asks.
async function startCheckServer(answer) {
	const calls = []
	const server = http.createServer((req, res) => {
		let raw = ''
		req.on('data', (chunk) => {
			raw += chunk
		})
		req.on('end', () => {
			const body = JSON.parse(raw || '{}')
			const call = {
				path: req.url,
				authorization: req.headers.authorization,
				workspace: req.headers['x-workspace-id'],
				session: req.headers['x-maskin-session-id'],
				idempotencyKey: req.headers['idempotency-key'],
				body,
			}
			calls.push(call)
			const { status, body: reply } = answer(call)
			res.statusCode = status
			res.setHeader('content-type', 'application/json')
			res.end(JSON.stringify(reply))
		})
	})
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	return {
		calls,
		url: `http://127.0.0.1:${server.address().port}`,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections()
				server.close(resolve)
			}),
	}
}

async function run(options, body) {
	const check = await startCheckServer(
		options.answer || (() => ({ status: 200, body: { held: false } })),
	)
	const stdin = new PassThrough()
	const stdout = new PassThrough()
	const stderr = new PassThrough()
	const waiting = new Map()
	let errText = ''
	let nextId = 1
	stderr.on('data', (chunk) => {
		errText += chunk.toString('utf8')
	})
	stdout.on(
		'data',
		splitLines((line) => {
			const message = JSON.parse(line)
			const wake = waiting.get(message.id)
			if (wake) {
				waiting.delete(message.id)
				wake(message)
			}
		}),
	)
	const env = {
		PATH: process.env.PATH,
		GITHUB_PERSONAL_ACCESS_TOKEN: 'fake-token-7777',
		FAKE_VALID_TOKEN: 'fake-token-7777',
		FAKE_TOOLS_LIST: '1',
		GITHUB_MCP_INTEGRATION_ID: 'fake-integration-abcd',
		MASKIN_API_URL: options.apiUrl || check.url,
		MASKIN_API_KEY: API_KEY,
		MASKIN_WORKSPACE_ID: WORKSPACE_ID,
		MASKIN_SESSION_ID: SESSION_ID,
	}
	for (const name of options.omit || []) delete env[name]
	const supervisor = createSupervisor({
		env,
		command: process.execPath,
		args: [FAKE_SERVER, 'stdio'],
		stdin,
		stdout,
		stderr,
		onExit: () => {},
	})
	supervisor.start()
	const request = (method, params) => {
		const id = nextId
		nextId += 1
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no response to ${method} ${id}`)), 8000)
			timer.unref()
			waiting.set(id, (message) => {
				clearTimeout(timer)
				resolve(message)
			})
			stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
		})
	}
	const h = {
		check,
		call: (name, args = {}) => request('tools/call', { name, arguments: args }),
		list: () => request('tools/list', {}),
		payload: (response) => JSON.parse(response.result.content[0].text),
		text: (response) => response.result.content[0].text,
		errText: () => errText,
	}
	try {
		await body(h)
	} finally {
		supervisor.stop()
		stdin.end()
		await check.close()
	}
	assert.ok(!errText.includes(API_KEY), 'the API key reached stderr')
	assert.ok(!/authorization|bearer/i.test(errText), 'a header reached stderr')
}

const held = (
	message = `${PILOT}. A card is waiting for a person to approve this exact call.`,
) => ({
	status: 200,
	body: { held: true, message },
})

test('a write that Maskin holds is refused with the pilot text and never reaches GitHub', async () => {
	await run({ answer: () => held() }, async (h) => {
		await h.list()
		const response = await h.call('create_or_update_file', { path: 'index.html' })
		assert.equal(response.result.isError, true)
		// A client on protocol 2026-07-28 rejects a result with no resultType as malformed, which
		// hid the pilot text behind a schema error.
		assert.equal(response.result.resultType, 'complete')
		assert.ok(h.text(response).startsWith(PILOT))
		assert.equal(h.check.calls.length, 1)
		const [call] = h.check.calls
		assert.equal(call.path, '/api/pilot-gate/check')
		assert.equal(call.authorization, `Bearer ${API_KEY}`)
		assert.equal(call.workspace, WORKSPACE_ID)
		assert.equal(call.session, SESSION_ID)
		assert.equal(call.body.tool, 'github__create_or_update_file')
		assert.deepEqual(call.body.arguments, { path: 'index.html' })
		assert.ok(call.idempotencyKey, 'every check carries a fresh idempotency key')
	})
})

test('a write Maskin lets through reaches GitHub', async () => {
	await run({}, async (h) => {
		await h.list()
		const response = await h.call('create_or_update_file', { tag: 'go' })
		assert.equal(h.payload(response).wrote, true)
		assert.equal(h.payload(response).tag, 'go')
	})
})

test('reads from the real tool list pass without asking Maskin', async () => {
	await run({ answer: () => held() }, async (h) => {
		await h.list()
		const response = await h.call('get_me', { tag: 'read' })
		assert.equal(h.payload(response).ok, true)
		assert.equal(h.check.calls.length, 0)
	})
})

test('a tool the list does not mark read-only counts as a write', async () => {
	await run({ answer: () => held() }, async (h) => {
		await h.list()
		const response = await h.call('unmarked_tool')
		assert.equal(response.result.isError, true)
		assert.equal(h.check.calls.length, 1)
	})
})

test('a call before any tool list was seen is checked, because nothing says it is a read', async () => {
	await run({ answer: () => held() }, async (h) => {
		const response = await h.call('get_me')
		assert.equal(response.result.isError, true)
		assert.equal(h.check.calls.length, 1)
	})
})

test('a check that errors holds the write', async () => {
	await run({ answer: () => ({ status: 500, body: { error: 'down' } }) }, async (h) => {
		await h.list()
		const response = await h.call('create_or_update_file')
		assert.equal(response.result.isError, true)
		assert.ok(h.text(response).startsWith(PILOT))
		assert.ok(h.text(response).includes('could not be checked'))
	})
})

test('a check that cannot be reached holds the write', async () => {
	await run({ apiUrl: 'http://127.0.0.1:9' }, async (h) => {
		await h.list()
		const response = await h.call('create_or_update_file')
		assert.equal(response.result.isError, true)
		assert.ok(h.text(response).includes('could not be checked'))
	})
})

test('an answer that is not a clear yes or no holds the write', async () => {
	await run({ answer: () => ({ status: 200, body: { unexpected: true } }) }, async (h) => {
		await h.list()
		const response = await h.call('create_or_update_file')
		assert.equal(response.result.isError, true)
	})
})

test('with no session id in the environment nothing is held and Maskin is not asked', async () => {
	await run({ omit: ['MASKIN_SESSION_ID'], answer: () => held() }, async (h) => {
		await h.list()
		const response = await h.call('create_or_update_file', { tag: 'free' })
		assert.equal(h.payload(response).wrote, true)
		assert.equal(h.check.calls.length, 0)
	})
})

test('the start log says the pilot hold is on', async () => {
	await run({}, async (h) => {
		await h.list()
		assert.match(h.errText(), /github-mcp-supervisor: pilot hold enabled/)
	})
})

test('the start log names the env that turns the pilot hold off', async () => {
	await run({ omit: ['MASKIN_SESSION_ID'] }, async (h) => {
		await h.list()
		assert.match(
			h.errText(),
			/github-mcp-supervisor: pilot hold disabled: missing env MASKIN_SESSION_ID/,
		)
	})
})
