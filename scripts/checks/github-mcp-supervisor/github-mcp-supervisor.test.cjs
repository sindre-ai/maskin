// Tests for docker/agent-base/github-mcp-supervisor.cjs, run with the Node test
// runner (CI: the unit-tests job). A fake github-mcp-server answers tool calls
// with GitHub's 401 error unless it was started with the token the test calls
// valid, and a fake mint server stands in for the github-token route.
//
// Every token below is a made-up string. The suite checks that none of them,
// and no API key, ever reaches the supervisor's stderr.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { PassThrough } = require('node:stream')

const {
	createSupervisor,
	REMINT_MARKER,
} = require('../../../docker/agent-base/github-mcp-supervisor.cjs')

const FAKE_SERVER = path.join(__dirname, 'fake-github-mcp-server.cjs')
const SUPERVISOR = path.join(
	__dirname,
	'..',
	'..',
	'..',
	'docker',
	'agent-base',
	'github-mcp-supervisor.cjs',
)
const STALE_TOKEN = 'fake-stale-token-1111'
const FRESH_TOKEN = 'fake-fresh-token-2222'
const API_KEY = 'fake-maskin-api-key-3333'
const WORKSPACE_ID = 'fake-workspace-4444'
const INTEGRATION_ID = 'fake-integration-abcd'
const SECRETS = [STALE_TOKEN, FRESH_TOKEN, API_KEY]
const ARGS = ['stdio', '--toolsets', 'context,repos']

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

async function startMintServer(initial = {}) {
	const state = { status: 200, token: FRESH_TOKEN, delayMs: 0, ...initial }
	const calls = []
	const waiters = []
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://mint.test')
		calls.push({
			path: url.pathname,
			reason: url.searchParams.get('reason'),
			authorization: req.headers.authorization,
			workspace: req.headers['x-workspace-id'],
		})
		for (const wake of waiters.splice(0)) wake()
		setTimeout(() => {
			res.statusCode = state.status
			res.setHeader('content-type', 'application/json')
			res.end(JSON.stringify(state.status === 200 ? { token: state.token } : { error: 'nope' }))
		}, state.delayMs)
	})
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	return {
		state,
		calls,
		url: `http://127.0.0.1:${server.address().port}`,
		nextCall: () => new Promise((resolve) => waiters.push(resolve)),
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections()
				server.close(resolve)
			}),
	}
}

async function setup(options = {}) {
	const mint = await startMintServer(options.mint)
	const clock = { now: 1_000_000 }
	const stdin = new PassThrough()
	const stdout = new PassThrough()
	const stderr = new PassThrough()
	const received = []
	const waiting = new Map()
	const exits = []
	let errText = ''
	let nextId = 1

	stderr.on('data', (chunk) => {
		errText += chunk.toString('utf8')
	})
	stdout.on(
		'data',
		splitLines((line) => {
			const message = JSON.parse(line)
			received.push(message)
			const wake = waiting.get(message.id)
			if (wake) {
				waiting.delete(message.id)
				wake(message)
			}
		}),
	)

	const env = {
		PATH: process.env.PATH,
		GITHUB_PERSONAL_ACCESS_TOKEN: STALE_TOKEN,
		FAKE_VALID_TOKEN: options.validToken || FRESH_TOKEN,
		GITHUB_MCP_INTEGRATION_ID: INTEGRATION_ID,
		MASKIN_API_URL: mint.url,
		MASKIN_API_KEY: API_KEY,
		MASKIN_WORKSPACE_ID: WORKSPACE_ID,
		GITHUB_MCP_REFRESH_AFTER_MS: '60000',
	}
	for (const name of options.omit || []) delete env[name]

	const supervisor = createSupervisor({
		env,
		command: process.execPath,
		args: [FAKE_SERVER, ...ARGS],
		spawn: options.spawn,
		drainCapMs: options.drainCapMs,
		now: () => clock.now,
		stdin,
		stdout,
		stderr,
		onExit: (code) => exits.push(code),
	})
	supervisor.start()

	function request(method, params) {
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

	return {
		mint,
		clock,
		received,
		exits,
		errText: () => errText,
		call: (name, args = {}) => request('tools/call', { name, arguments: args }),
		request,
		notify: (method) => stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
		closeStdin: () => stdin.end(),
		payload: (response) => JSON.parse(response.result.content[0].text),
		close: async () => {
			supervisor.stop()
			stdin.end()
			await mint.close()
		},
	}
}

// Runs the body, tears everything down, then checks that no secret reached stderr.
async function withSupervisor(options, body) {
	const h = await setup(options)
	try {
		await body(h)
	} finally {
		await h.close()
	}
	for (const secret of SECRETS) {
		assert.ok(!h.errText().includes(secret), 'a token or key reached stderr')
	}
	assert.ok(!/authorization|bearer/i.test(h.errText()), 'a header reached stderr')
}

function remintLines(h) {
	return h
		.errText()
		.split('\n')
		.filter((line) => line.includes('re-mint'))
}

function waitFor(check, what) {
	return new Promise((resolve, reject) => {
		const started = Date.now()
		const timer = setInterval(() => {
			if (check()) {
				clearInterval(timer)
				resolve()
			} else if (Date.now() - started > 5000) {
				clearInterval(timer)
				reject(new Error(`timed out waiting for ${what}`))
			}
		}, 10)
	})
}

test('age: next request after the threshold gives one mint, one restart, one normal response', async () => {
	await withSupervisor({}, async (h) => {
		await h.request('initialize', { protocolVersion: '2025-06-18' })
		h.notify('notifications/initialized')
		const before = h.payload(await h.call('stats'))
		h.clock.now += 61_000
		const response = await h.call('get_me', { tag: 'after-age' })
		assert.equal(response.result.isError, undefined)
		const served = h.payload(response)
		assert.equal(served.ok, true)
		assert.notEqual(served.pid, before.pid)
		assert.equal(h.mint.calls.length, 1)
		assert.equal(h.mint.calls[0].reason, 'mcp_age')
		assert.equal(h.mint.calls[0].authorization, `Bearer ${API_KEY}`)
		assert.equal(h.mint.calls[0].workspace, WORKSPACE_ID)
		assert.equal(h.mint.calls[0].path, `/api/integrations/${INTEGRATION_ID}/github-token`)
		assert.equal(remintLines(h).length, 1)
		assert.match(remintLines(h)[0], /reason=age count=1 integration=abcd/)
		const after = h.payload(await h.call('stats'))
		assert.equal(after.pid, served.pid)
		assert.equal(after.authCalls, 1)
	})
})

test('401: one mint, one replay, success', async () => {
	await withSupervisor({}, async (h) => {
		const before = h.payload(await h.call('stats'))
		const response = await h.call('get_me', { tag: 'expired' })
		assert.equal(response.result.isError, undefined)
		const served = h.payload(response)
		assert.equal(served.ok, true)
		assert.equal(served.tag, 'expired')
		assert.notEqual(served.pid, before.pid)
		assert.equal(h.mint.calls.length, 1)
		assert.equal(h.mint.calls[0].reason, 'mcp_401')
		assert.match(remintLines(h)[0], /reason=401 count=1/)
		const after = h.payload(await h.call('stats'))
		assert.equal(after.authCalls, 1)
		assert.ok(!response.result.content[0].text.includes(REMINT_MARKER))
	})
})

test('second 401 surfaces GITHUB_REMINT_UNRESOLVED_401 once and does not try a third time', async () => {
	await withSupervisor({ validToken: 'fake-token-nobody-has-9999' }, async (h) => {
		const response = await h.call('get_me')
		assert.equal(response.result.isError, true)
		const text = response.result.content[0].text
		assert.equal(text.split(REMINT_MARKER).length - 1, 1)
		assert.match(text, /401 Bad credentials/)
		assert.equal(h.mint.calls.length, 1)
		const after = h.payload(await h.call('stats'))
		assert.equal(after.authCalls, 1)
	})
})

test('non-401 error passes through and mints nothing', async () => {
	await withSupervisor({ validToken: STALE_TOKEN }, async (h) => {
		const response = await h.call('forbidden')
		assert.equal(response.result.isError, true)
		assert.match(response.result.content[0].text, /403 Resource not accessible/)
		assert.ok(!response.result.content[0].text.includes(REMINT_MARKER))
		assert.equal(h.mint.calls.length, 0)
	})
})

test('a 404 error whose URL contains 401 passes through and mints nothing', async () => {
	await withSupervisor({}, async (h) => {
		const response = await h.call('issue_401_not_found')
		assert.equal(response.result.isError, true)
		assert.match(response.result.content[0].text, /404 Not Found/)
		assert.ok(!response.result.content[0].text.includes(REMINT_MARKER))
		assert.equal(h.mint.calls.length, 0)
		assert.equal(remintLines(h).length, 0)
	})
})

test('a successful result that only contains the text 401 does not trigger a mint', async () => {
	await withSupervisor({}, async (h) => {
		const response = await h.call('mentions_401')
		assert.equal(response.result.isError, undefined)
		assert.match(response.result.content[0].text, /401 Bad credentials/)
		assert.equal(h.mint.calls.length, 0)
		assert.equal(remintLines(h).length, 0)
	})
})

test('init replay: the new child gets initialize and initialized exactly once, the client one initialize response', async () => {
	await withSupervisor({}, async (h) => {
		await h.request('initialize', { protocolVersion: '2025-06-18' })
		h.notify('notifications/initialized')
		const before = h.payload(await h.call('stats'))
		assert.equal(before.initializeCount, 1)
		assert.equal(before.initializedCount, 1)
		await h.call('get_me')
		const after = h.payload(await h.call('stats'))
		assert.notEqual(after.pid, before.pid)
		assert.equal(after.initializeCount, 1)
		assert.equal(after.initializedCount, 1)
		const initializeResponses = h.received.filter((m) => m.result?.serverInfo)
		assert.equal(initializeResponses.length, 1)
		assert.equal(h.received.filter((m) => m.id === undefined).length, 0)
	})
})

test('no cached initialize: nothing is replayed and the new child still answers', async () => {
	await withSupervisor({}, async (h) => {
		const before = h.payload(await h.call('stats'))
		await h.call('get_me')
		const after = h.payload(await h.call('stats'))
		assert.notEqual(after.pid, before.pid)
		assert.equal(after.initializeCount, 0)
		assert.equal(after.initializedCount, 0)
		assert.equal(h.payload(await h.call('echo', { tag: 'still-works' })).tag, 'still-works')
	})
})

test('an unknown method passes through to the child', async () => {
	await withSupervisor({}, async (h) => {
		const response = await h.request('server/discover', {})
		assert.deepEqual(response.result, { discovered: true })
		assert.equal(h.mint.calls.length, 0)
	})
})

test('three requests that arrive during an age restart are answered in order', async () => {
	await withSupervisor({ mint: { delayMs: 150 } }, async (h) => {
		h.clock.now += 61_000
		const first = h.call('echo', { tag: 'one' })
		const second = h.call('echo', { tag: 'two' })
		const third = h.call('echo', { tag: 'three' })
		const responses = await Promise.all([first, second, third])
		assert.deepEqual(
			responses.map((r) => h.payload(r).tag),
			['one', 'two', 'three'],
		)
		assert.deepEqual(
			h.received.map((m) => m.id),
			[1, 2, 3],
		)
		assert.equal(new Set(responses.map((r) => h.payload(r).pid)).size, 1)
		assert.equal(h.mint.calls.length, 1)
	})
})

test('requests that arrive during a 401 restart wait for it and are answered in order', async () => {
	await withSupervisor({ mint: { delayMs: 200 } }, async (h) => {
		const failing = h.call('get_me', { tag: 'failing' })
		await h.mint.nextCall()
		const second = h.call('echo', { tag: 'two' })
		const third = h.call('echo', { tag: 'three' })
		const responses = await Promise.all([failing, second, third])
		assert.equal(responses[0].result.isError, undefined)
		assert.deepEqual(
			responses.map((r) => h.payload(r).tag),
			['failing', 'two', 'three'],
		)
		assert.deepEqual(
			h.received.map((m) => m.id),
			[1, 2, 3],
		)
		assert.equal(h.mint.calls.length, 1)
	})
})

test('mint failure keeps the old child and honours the 30 second backoff', async () => {
	await withSupervisor({ validToken: STALE_TOKEN, mint: { status: 500 } }, async (h) => {
		const before = h.payload(await h.call('stats'))
		h.clock.now += 61_000
		const first = h.payload(await h.call('get_me'))
		assert.equal(first.ok, true)
		assert.equal(first.pid, before.pid)
		assert.equal(h.mint.calls.length, 1)
		assert.match(h.errText(), /mint failed status=500/)
		assert.equal(remintLines(h).length, 0)

		h.clock.now += 10_000
		assert.equal(h.payload(await h.call('get_me')).pid, before.pid)
		assert.equal(h.mint.calls.length, 1)

		h.clock.now += 21_000
		assert.equal(h.payload(await h.call('get_me')).pid, before.pid)
		assert.equal(h.mint.calls.length, 2)
	})
})

test('a 401 with a failing mint returns what GitHub said and does not loop', async () => {
	await withSupervisor({ mint: { status: 403 } }, async (h) => {
		const response = await h.call('get_me')
		assert.equal(response.result.isError, true)
		assert.match(response.result.content[0].text, /401 Bad credentials/)
		assert.ok(!response.result.content[0].text.includes(REMINT_MARKER))
		assert.equal(h.mint.calls.length, 1)
		assert.match(h.errText(), /mint failed status=403/)
	})
})

test('repeated 401s mint at most once per 30 seconds', async () => {
	await withSupervisor({ validToken: 'fake-token-nobody-has-9999' }, async (h) => {
		await h.call('get_me')
		assert.equal(h.mint.calls.length, 1)

		const again = await h.call('get_me')
		assert.equal(again.result.isError, true)
		assert.equal(h.mint.calls.length, 1)

		h.clock.now += 29_000
		await h.call('get_me')
		assert.equal(h.mint.calls.length, 1)

		h.clock.now += 2_000
		await h.call('get_me')
		assert.equal(h.mint.calls.length, 2)
	})
})

test('parallel calls that all hit the expiry are each answered after a single mint', async () => {
	await withSupervisor({ mint: { delayMs: 100 } }, async (h) => {
		const responses = await Promise.all([
			h.call('get_me', { tag: 'a' }),
			h.call('get_me', { tag: 'b' }),
			h.call('get_me', { tag: 'c' }),
		])
		for (const response of responses) {
			assert.equal(response.result.isError, undefined)
			assert.ok(!response.result.content[0].text.includes(REMINT_MARKER))
		}
		assert.deepEqual(
			responses.map((r) => h.payload(r).tag),
			['a', 'b', 'c'],
		)
		assert.equal(new Set(responses.map((r) => h.payload(r).pid)).size, 1)
		assert.equal(h.mint.calls.length, 1)
		assert.equal(remintLines(h).length, 1)
		const stats = h.payload(await h.call('stats'))
		assert.equal(stats.initializeCount, 0)
	})
})

test('a call still running on the old child is answered with an error when that child dies', async () => {
	await withSupervisor({}, async (h) => {
		const before = h.payload(await h.call('stats'))
		const slow = h.call('slow', { ms: 60_000, tag: 'slow' })
		const recovered = await h.call('get_me', { tag: 'expired' })
		assert.equal(recovered.result.isError, undefined)
		process.kill(before.pid)
		const response = await slow
		assert.equal(response.result, undefined)
		assert.equal(response.error.code, -32603)
		assert.match(response.error.message, /Retry the call/)
		assert.deepEqual(h.exits, [])
		assert.equal(h.payload(await h.call('echo', { tag: 'after' })).tag, 'after')
	})
})

test('a call still running when the drain cap kills the old child is answered with an error', async () => {
	await withSupervisor({ drainCapMs: 200 }, async (h) => {
		const slow = h.call('slow', { ms: 60_000, tag: 'slow' })
		await h.call('get_me', { tag: 'expired' })
		const response = await slow
		assert.equal(response.error.code, -32603)
		assert.deepEqual(h.exits, [])
		assert.equal(h.payload(await h.call('echo', { tag: 'after' })).tag, 'after')
	})
})

function failingSecondSpawn() {
	let calls = 0
	return (...args) => {
		calls += 1
		if (calls > 1) throw new Error('spawn EMFILE')
		return require('node:child_process').spawn(...args)
	}
}

test('a restart that throws during 401 recovery delivers the original answer and keeps the pipe working', async () => {
	await withSupervisor({ spawn: failingSecondSpawn() }, async (h) => {
		const response = await h.call('get_me')
		assert.equal(response.result.isError, true)
		assert.match(response.result.content[0].text, /401 Bad credentials/)
		assert.match(h.errText(), /recovery failed/)
		assert.deepEqual(h.exits, [])
		assert.equal(h.payload(await h.call('echo', { tag: 'after' })).tag, 'after')
	})
})

test('an age restart that throws still answers the request on the current child', async () => {
	await withSupervisor({ spawn: failingSecondSpawn(), validToken: STALE_TOKEN }, async (h) => {
		h.clock.now += 61_000
		const response = await h.call('echo', { tag: 'aged' })
		assert.equal(h.payload(response).tag, 'aged')
		assert.match(h.errText(), /age refresh failed/)
		assert.deepEqual(h.exits, [])
	})
})

test('the child environment has no MASKIN_ variable, before and after a restart', async () => {
	await withSupervisor({}, async (h) => {
		const before = h.payload(await h.call('stats'))
		assert.deepEqual(before.maskinKeys, [])
		assert.equal(before.hasGithubToken, true)
		await h.call('get_me')
		const after = h.payload(await h.call('stats'))
		assert.notEqual(after.pid, before.pid)
		assert.deepEqual(after.maskinKeys, [])
		assert.equal(after.hasGithubToken, true)
	})
})

test('missing env disables refresh, names only, and the child still works', async () => {
	await withSupervisor(
		{ validToken: STALE_TOKEN, omit: ['GITHUB_MCP_INTEGRATION_ID', 'MASKIN_API_KEY'] },
		async (h) => {
			assert.match(
				h.errText(),
				/refresh disabled: missing env GITHUB_MCP_INTEGRATION_ID,MASKIN_API_KEY/,
			)
			assert.equal(h.payload(await h.call('echo', { tag: 'ok' })).tag, 'ok')
			h.clock.now += 61_000
			assert.equal(h.payload(await h.call('get_me')).ok, true)
			assert.equal(h.mint.calls.length, 0)
		},
	)
})

test('missing env: a 401 passes through without a mint', async () => {
	await withSupervisor({ omit: ['MASKIN_API_KEY'] }, async (h) => {
		const response = await h.call('get_me')
		assert.equal(response.result.isError, true)
		assert.match(response.result.content[0].text, /401 Bad credentials/)
		assert.equal(h.mint.calls.length, 0)
	})
})

test('with env present the start line says env ok', async () => {
	await withSupervisor({}, async (h) => {
		await h.call('echo')
		assert.match(h.errText(), /env ok, refresh enabled/)
	})
})

test('the child exiting on its own makes the supervisor exit with its code', async () => {
	await withSupervisor({}, async (h) => {
		h.call('crash').catch(() => {})
		await waitFor(() => h.exits.length > 0, 'supervisor exit')
		assert.deepEqual(h.exits, [3])
	})
})

test('the client closing stdin kills the child and exits', async () => {
	await withSupervisor({}, async (h) => {
		const { pid } = h.payload(await h.call('stats'))
		h.closeStdin()
		await waitFor(() => h.exits.length > 0, 'supervisor exit')
		assert.deepEqual(h.exits, [0])
		await waitFor(() => {
			try {
				process.kill(pid, 0)
				return false
			} catch {
				return true
			}
		}, 'child to die')
	})
})

// The same checks through the real entry point: a github-mcp-server found on
// PATH, started with the arguments the plain binary would get.
test('entry point: runs github-mcp-server from PATH with the same arguments and no MASKIN_ variable', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-mcp-supervisor-'))
	const shim = path.join(dir, 'github-mcp-server')
	fs.writeFileSync(shim, `#!/usr/bin/env node\nrequire(${JSON.stringify(FAKE_SERVER)})\n`)
	fs.chmodSync(shim, 0o755)
	const mint = await startMintServer()
	const proc = spawn(process.execPath, [SUPERVISOR, ...ARGS], {
		env: {
			PATH: `${dir}${path.delimiter}${process.env.PATH}`,
			GITHUB_PERSONAL_ACCESS_TOKEN: STALE_TOKEN,
			FAKE_VALID_TOKEN: FRESH_TOKEN,
			GITHUB_MCP_INTEGRATION_ID: INTEGRATION_ID,
			MASKIN_API_URL: mint.url,
			MASKIN_API_KEY: API_KEY,
			MASKIN_WORKSPACE_ID: WORKSPACE_ID,
		},
		stdio: ['pipe', 'pipe', 'pipe'],
	})
	let errText = ''
	const lines = []
	proc.stderr.on('data', (chunk) => {
		errText += chunk.toString('utf8')
	})
	proc.stdout.on(
		'data',
		splitLines((line) => lines.push(JSON.parse(line))),
	)
	const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)))
	const send = (id, name) =>
		proc.stdin.write(
			`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })}\n`,
		)
	try {
		send(1, 'stats')
		await waitFor(() => lines.length === 1, 'stats response')
		const stats = JSON.parse(lines[0].result.content[0].text)
		assert.deepEqual(stats.argv, ARGS)
		assert.deepEqual(stats.maskinKeys, [])
		await waitFor(() => /env ok, refresh enabled/.test(errText), 'start line')

		send(2, 'get_me')
		await waitFor(() => lines.length === 2, 'get_me response')
		assert.equal(lines[1].result.isError, undefined)
		assert.equal(mint.calls.length, 1)

		send(3, 'crash')
		assert.equal(await exited, 3)
	} finally {
		proc.kill()
		await mint.close()
		fs.rmSync(dir, { recursive: true, force: true })
	}
	for (const secret of SECRETS) {
		assert.ok(!errText.includes(secret), 'a token or key reached stderr')
	}
})
