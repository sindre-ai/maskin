#!/usr/bin/env node
// Supervisor for the GitHub MCP server (github-mcp-server stdio).
//
// Claude Code starts this instead of the plain binary. It spawns the Go server
// as a child and relays stdin/stdout, so the pipe Claude Code holds never
// closes. The Go server reads its token once at start and GitHub App
// installation tokens live one hour, so the supervisor mints a fresh token
// through the same route the git credential helper uses and restarts the child
// behind the pipe: when the launch token gets old (age) and when a tool result
// says the token is bad (401).
//
// No dependencies. Node 22 is in the image. Never logs a token or a header.

const { spawn } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')

const REMINT_MARKER = 'GITHUB_REMINT_UNRESOLVED_401'
const DEFAULT_REFRESH_AFTER_MS = 45 * 60 * 1000
const MINT_COOLDOWN_MS = 30 * 1000
const DRAIN_CAP_MS = 30 * 1000
const MINT_TIMEOUT_MS = 10 * 1000
const INIT_REPLAY_TIMEOUT_MS = 10 * 1000
const REQUIRED_ENV = [
	'GITHUB_MCP_INTEGRATION_ID',
	'MASKIN_API_URL',
	'MASKIN_API_KEY',
	'MASKIN_WORKSPACE_ID',
]

// An expiry is an isError tool result carrying GitHub's 401 / Bad credentials
// text. A successful result that merely mentions 401 does not count.
function isExpiryResult(message) {
	const result = message?.result
	if (!result || result.isError !== true || !Array.isArray(result.content)) return false
	const text = result.content
		.map((part) => (part && typeof part.text === 'string' ? part.text : ''))
		.join('\n')
	return /\b401\b|bad credentials/i.test(text)
}

function withMarker(message) {
	const copy = JSON.parse(JSON.stringify(message))
	const parts = copy.result.content
	const last = parts[parts.length - 1]
	if (last && typeof last.text === 'string') last.text = `${last.text} ${REMINT_MARKER}`
	else parts.push({ type: 'text', text: REMINT_MARKER })
	return copy
}

function lineSplitter(onLine) {
	const decoder = new StringDecoder('utf8')
	let buffered = ''
	return (chunk) => {
		buffered += decoder.write(chunk)
		let index = buffered.indexOf('\n')
		while (index !== -1) {
			const line = buffered.slice(0, index).replace(/\r$/, '')
			buffered = buffered.slice(index + 1)
			if (line.length > 0) onLine(line)
			index = buffered.indexOf('\n')
		}
	}
}

function parse(line) {
	try {
		const value = JSON.parse(line)
		return value && typeof value === 'object' ? value : null
	} catch {
		return null
	}
}

function isRequest(message) {
	return message && typeof message.method === 'string' && message.id !== undefined
}

function createSupervisor(options) {
	const env = options.env
	const now = options.now || Date.now
	const doFetch = options.fetch || fetch
	const spawnChild = options.spawn || spawn
	const command = options.command || 'github-mcp-server'
	const childArgs = options.args || []
	const input = options.stdin
	const output = options.stdout
	const errput = options.stderr
	const onExit = options.onExit

	const missing = REQUIRED_ENV.filter((name) => !env[name])
	const refreshEnabled = missing.length === 0
	const refreshAfterMs = Number(env.GITHUB_MCP_REFRESH_AFTER_MS) || DEFAULT_REFRESH_AFTER_MS
	const integrationTail = String(env.GITHUB_MCP_INTEGRATION_ID || '').slice(-4)

	let token = env.GITHUB_PERSONAL_ACCESS_TOKEN || ''
	let tokenIssuedAt = now()
	let lastMintAt = null
	let mintCount = 0
	let current = null
	let gate = null
	let cachedInitialize = null
	let cachedInitialized = null
	let replaySeq = 0
	let stopped = false
	let drainWaiters = []
	const inflight = new Map()
	const retired = new Set()
	const replayWaiters = new Map()
	const pending = []
	let pumping = false

	function log(text) {
		errput.write(`github-mcp-supervisor: ${text}\n`)
	}

	// The child gets the GitHub token and nothing from Maskin.
	function childEnv() {
		const out = {}
		for (const [name, value] of Object.entries(env)) {
			if (!name.startsWith('MASKIN_')) out[name] = value
		}
		out.GITHUB_PERSONAL_ACCESS_TOKEN = token
		return out
	}

	function startChild() {
		const proc = spawnChild(command, childArgs, {
			env: childEnv(),
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		const child = { proc, ids: new Set(), retiring: false }
		proc.stdin.on('error', () => {})
		proc.stdout.on(
			'data',
			lineSplitter((line) => onChildLine(child, line)),
		)
		proc.stderr.on('data', (chunk) => errput.write(chunk))
		proc.on('error', (err) => {
			if (current === child) {
				log(`child failed to start: ${err?.code ? err.code : 'error'}`)
				finish(1)
			}
		})
		proc.on('exit', (code) => {
			if (current === child && !stopped) finish(code === null ? 1 : code)
		})
		return child
	}

	function finish(code) {
		if (stopped) return
		stopped = true
		for (const child of [current, ...retired]) {
			if (child) child.proc.kill()
		}
		onExit(code)
	}

	function retire(child) {
		child.retiring = true
		if (child.ids.size === 0) {
			child.proc.kill()
			return
		}
		retired.add(child)
		const timer = setTimeout(() => child.proc.kill(), DRAIN_CAP_MS)
		timer.unref()
	}

	function send(child, message) {
		child.proc.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`)
	}

	function forward(line, message) {
		if (isRequest(message)) {
			inflight.set(JSON.stringify(message.id), {
				child: current,
				message,
				line,
				retried: false,
				original: null,
			})
			current.ids.add(JSON.stringify(message.id))
		}
		send(current, line)
	}

	function settle(key) {
		const entry = inflight.get(key)
		if (!entry) return
		inflight.delete(key)
		entry.child.ids.delete(key)
		if (entry.child.retiring && entry.child.ids.size === 0) {
			entry.child.proc.kill()
			retired.delete(entry.child)
		}
		if (inflight.size === 0) {
			const waiters = drainWaiters
			drainWaiters = []
			for (const wake of waiters) wake()
		}
	}

	function drained() {
		if (inflight.size === 0) return Promise.resolve()
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, DRAIN_CAP_MS)
			drainWaiters.push(() => {
				clearTimeout(timer)
				resolve()
			})
		})
	}

	// Returns a fresh token, or null when no mint is allowed or the call fails.
	// At most one attempt per 30 seconds, whatever the reason and whatever the result.
	async function mint(reason) {
		if (!refreshEnabled) return null
		const at = now()
		if (lastMintAt !== null && at - lastMintAt < MINT_COOLDOWN_MS) return null
		lastMintAt = at
		const base = String(env.MASKIN_API_URL).replace(/\/+$/, '')
		const url = `${base}/api/integrations/${encodeURIComponent(env.GITHUB_MCP_INTEGRATION_ID)}/github-token?reason=${reason}`
		try {
			const res = await doFetch(url, {
				headers: {
					Authorization: `Bearer ${env.MASKIN_API_KEY}`,
					'X-Workspace-Id': env.MASKIN_WORKSPACE_ID,
				},
				signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
			})
			if (!res.ok) {
				log(`mint failed status=${res.status} reason=${reason}, keeping current token`)
				return null
			}
			const body = await res.json()
			if (!body || typeof body.token !== 'string' || body.token.length === 0) {
				log(`mint failed status=${res.status} reason=${reason}, no token in body`)
				return null
			}
			return body.token
		} catch (err) {
			const kind = err && err.name === 'TimeoutError' ? 'timeout' : 'network'
			log(`mint failed status=${kind} reason=${reason}, keeping current token`)
			return null
		}
	}

	function replayInit(child) {
		if (!cachedInitialize) return Promise.resolve()
		replaySeq += 1
		const id = `supervisor-init-${replaySeq}`
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				replayWaiters.delete(id)
				log('init replay got no response, carrying on')
				resolve()
			}, INIT_REPLAY_TIMEOUT_MS)
			replayWaiters.set(id, () => {
				clearTimeout(timer)
				resolve()
			})
			send(child, { ...cachedInitialize, id })
		}).then(() => {
			if (cachedInitialized) send(child, cachedInitialized)
		})
	}

	// Swap the child for one started with the new token. The old child keeps
	// answering what it already has; it is killed once those are done.
	async function restart(newToken, reason) {
		token = newToken
		tokenIssuedAt = now()
		mintCount += 1
		log(`re-mint reason=${reason} count=${mintCount} integration=${integrationTail}`)
		const old = current
		current = startChild()
		if (old) retire(old)
		await replayInit(current)
	}

	async function ageRefresh() {
		if (!refreshEnabled || now() - tokenIssuedAt < refreshAfterMs) return
		const due = lastMintAt === null || now() - lastMintAt >= MINT_COOLDOWN_MS
		if (!due) return
		await drained()
		const fresh = await mint('mcp_age')
		if (fresh) await restart(fresh, 'age')
	}

	async function handleClientLine(line) {
		const message = parse(line)
		if (message && message.method === 'initialize') cachedInitialize = message
		else if (message && message.method === 'notifications/initialized') cachedInitialized = message
		else if (isRequest(message)) await ageRefresh()
		if (stopped) return
		forward(line, message)
	}

	async function pump() {
		if (pumping) return
		pumping = true
		while (pending.length > 0 && !stopped) {
			if (gate) await gate
			try {
				await handleClientLine(pending.shift())
			} catch {
				log('error handling a client message')
			}
		}
		pumping = false
	}

	async function recover(entry, message) {
		const fresh = await mint('mcp_401')
		if (!fresh) {
			deliver(entry, message)
			return
		}
		const key = JSON.stringify(entry.message.id)
		entry.retried = true
		entry.original = message
		entry.child.ids.delete(key)
		await restart(fresh, '401')
		entry.child = current
		current.ids.add(key)
		send(current, entry.line)
	}

	function deliver(entry, message) {
		settle(JSON.stringify(entry.message.id))
		output.write(`${JSON.stringify(message)}\n`)
	}

	function onChildLine(child, line) {
		const message = parse(line)
		const isResponse =
			message && message.method === undefined && message.id !== undefined && !stopped
		if (!isResponse) {
			if (!stopped) output.write(`${line}\n`)
			return
		}
		const waiter = replayWaiters.get(message.id)
		if (waiter) {
			replayWaiters.delete(message.id)
			waiter()
			return
		}
		const key = JSON.stringify(message.id)
		const entry = inflight.get(key)
		if (!entry || entry.child !== child) {
			output.write(`${line}\n`)
			return
		}
		if (!isExpiryResult(message)) {
			deliver(entry, message)
			return
		}
		if (entry.retried) {
			deliver(entry, withMarker(entry.original))
			return
		}
		// Hold everything behind the restart so order is kept.
		gate = recover(entry, message).finally(() => {
			gate = null
		})
	}

	function start() {
		if (refreshEnabled) log('env ok, refresh enabled')
		else log(`refresh disabled: missing env ${missing.join(',')}`)
		current = startChild()
		input.on(
			'data',
			lineSplitter((line) => {
				pending.push(line)
				pump()
			}),
		)
		input.on('end', () => finish(0))
		input.on('close', () => finish(0))
	}

	return { start, stop: () => finish(0) }
}

function main() {
	createSupervisor({
		env: process.env,
		args: process.argv.slice(2),
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		onExit: (code) => process.exit(code),
	}).start()
}

if (require.main === module) main()

module.exports = { createSupervisor, isExpiryResult, REMINT_MARKER }
