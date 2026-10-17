#!/usr/bin/env node
// maskin-mcp-guard: default-deny per-tool guard for customer-declared MCP servers.
//
// The agent runtime (Claude Code) starts each MCP server itself inside the
// container, so Maskin's API never sees a tool call. The launch config instead
// starts this wrapper first, and the wrapper starts the real server as a child:
//
//   maskin-mcp-guard -- npx mcp-remote https://vendor.example/mcp
//
// It is a stdio proxy for newline-delimited JSON-RPC. Everything passes through
// byte for byte except a tools/call whose tool is not allowed: that request
// never reaches the child, the wrapper answers it with an error, and the denial
// is reported to the API. tools/list is NEVER filtered, so the agent can see the
// tool it was refused (R4, Scenario C).
//
// Config comes from the launch env, never from args, so the session key stays
// out of the envsubst'd mcp-config file. The child does not inherit MASKIN_GUARD_*.
//   MASKIN_GUARD_ALLOW        JSON array of tool names the agent may call. Unset,
//                             empty or invalid means every tool is denied.
//   MASKIN_GUARD_DENY         JSON array of tool names refused even if allowed.
//   MASKIN_GUARD_REPORT_URL   Endpoint that records a denial.
//   MASKIN_GUARD_SESSION_KEY  Secret bound to one session and one extension. The
//                             API takes both from the key, so the report body
//                             carries only the tool name.
//
// Limits: the MCP credential is in the container env, so an agent with a shell
// can bypass the wrapper. It stops over-reach and leaves an audit trail; it does
// not stop a hostile agent.
//
// Usage: maskin-mcp-guard [--version] -- <command> [args...]

const { spawn } = require('node:child_process')

const VERSION = '0.1.0'
const NAME = 'maskin-mcp-guard'
const ENV_PREFIX = 'MASKIN_GUARD_'
const REPORT_TIMEOUT_MS = 5000
const DRAIN_TIMEOUT_MS = 5000

const FORBIDDEN_MESSAGE = 'ACL: tool not granted'
// JSON-RPC error codes must be integers, so the string code "forbidden" rides in
// error.data.code. -32003 sits in the implementation-defined server error range.
const FORBIDDEN_RPC_CODE = -32003
const PARSE_ERROR_RPC_CODE = -32700

function parseList(raw) {
	if (!raw) return []
	try {
		const value = JSON.parse(raw)
		return Array.isArray(value) ? value.filter((name) => typeof name === 'string') : []
	} catch {
		return []
	}
}

function loadConfig(env) {
	return {
		allow: new Set(parseList(env.MASKIN_GUARD_ALLOW)),
		deny: new Set(parseList(env.MASKIN_GUARD_DENY)),
		reportUrl: env.MASKIN_GUARD_REPORT_URL || '',
		sessionKey: env.MASKIN_GUARD_SESSION_KEY || '',
	}
}

// Deny wins over allow; a tool in neither list is denied.
function isAllowed(config, toolName) {
	if (typeof toolName !== 'string' || toolName === '') return false
	if (config.deny.has(toolName)) return false
	return config.allow.has(toolName)
}

function forbiddenResponse(id, toolName) {
	return {
		jsonrpc: '2.0',
		id,
		error: {
			code: FORBIDDEN_RPC_CODE,
			message: FORBIDDEN_MESSAGE,
			data: { code: 'forbidden', tool: typeof toolName === 'string' ? toolName : null },
		},
	}
}

function hasId(message) {
	return message.id !== undefined && message.id !== null
}

// Decide what to do with one parsed JSON-RPC message from the agent. Returns
// { forward: bool, reply?: object, denied?: toolName }.
function inspectMessage(config, message) {
	if (!message || typeof message !== 'object' || Array.isArray(message)) {
		return { forward: true }
	}
	if (message.method !== 'tools/call') return { forward: true }
	const toolName = message.params?.name
	if (isAllowed(config, toolName)) return { forward: true }
	return {
		forward: false,
		denied: typeof toolName === 'string' ? toolName : '',
		// A notification has no id and takes no reply.
		reply: hasId(message) ? forbiddenResponse(message.id, toolName) : undefined,
	}
}

// Handle one line from the agent. Returns the line to forward to the child (or
// null), the lines to send back to the agent, and the denied tool names.
function processLine(config, line) {
	const result = { forward: null, replies: [], denied: [] }
	let parsed
	try {
		parsed = JSON.parse(line)
	} catch {
		// Fail closed: a line this wrapper cannot parse is never handed to a
		// server that might parse it more leniently.
		result.replies.push({
			jsonrpc: '2.0',
			id: null,
			error: { code: PARSE_ERROR_RPC_CODE, message: 'Parse error' },
		})
		return result
	}

	if (Array.isArray(parsed)) {
		const kept = []
		for (const entry of parsed) {
			const verdict = inspectMessage(config, entry)
			if (verdict.forward) kept.push(entry)
			else {
				result.denied.push(verdict.denied)
				if (verdict.reply) result.replies.push(verdict.reply)
			}
		}
		if (kept.length === parsed.length) result.forward = line
		else if (kept.length > 0) result.forward = JSON.stringify(kept)
		return result
	}

	const verdict = inspectMessage(config, parsed)
	if (verdict.forward) result.forward = line
	else {
		result.denied.push(verdict.denied)
		if (verdict.reply) result.replies.push(verdict.reply)
	}
	return result
}

// Report one denial. Never throws and never blocks the refusal: a down API must
// not turn a denied call into an allowed one or a hung one.
async function reportDenial(config, toolName, fetchImpl = globalThis.fetch) {
	if (!config.reportUrl || !config.sessionKey) return false
	try {
		const res = await fetchImpl(config.reportUrl, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${config.sessionKey}`,
			},
			body: JSON.stringify({ tool_name: toolName }),
			signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
		})
		if (!res.ok) {
			console.error(`${NAME}: denial report rejected with HTTP ${res.status}`)
			return false
		}
		return true
	} catch (err) {
		console.error(`${NAME}: denial report failed: ${err.message}`)
		return false
	}
}

function childEnv(env) {
	const out = {}
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith(ENV_PREFIX)) out[key] = value
	}
	return out
}

// Split a stream into whole lines so a synthetic reply is never written into
// the middle of a line the child is still sending.
function lineSplitter(onLine) {
	let buffer = ''
	return {
		push(chunk) {
			buffer += chunk
			let index = buffer.indexOf('\n')
			while (index !== -1) {
				const line = buffer.slice(0, index).replace(/\r$/, '')
				buffer = buffer.slice(index + 1)
				if (line !== '') onLine(line)
				index = buffer.indexOf('\n')
			}
		},
		flush() {
			const line = buffer.replace(/\r$/, '')
			buffer = ''
			if (line !== '') onLine(line)
		},
	}
}

function run(argv, env) {
	const separator = argv.indexOf('--')
	const command = separator === -1 ? [] : argv.slice(separator + 1)
	if (command.length === 0) {
		console.error(`${NAME}: usage: ${NAME} [--version] -- <command> [args...]`)
		return 2
	}

	const config = loadConfig(env)
	const pending = new Set()
	const child = spawn(command[0], command.slice(1), {
		env: childEnv(env),
		stdio: ['pipe', 'pipe', 'inherit'],
	})

	const writeToAgent = (message) => {
		process.stdout.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`)
	}

	const fromAgent = lineSplitter((line) => {
		const { forward, replies, denied } = processLine(config, line)
		for (const toolName of denied) {
			const report = reportDenial(config, toolName).finally(() => pending.delete(report))
			pending.add(report)
		}
		for (const reply of replies) writeToAgent(reply)
		if (forward !== null && !child.stdin.destroyed) child.stdin.write(`${forward}\n`)
	})
	const fromChild = lineSplitter(writeToAgent)

	process.stdin.setEncoding('utf8')
	process.stdin.on('data', (chunk) => fromAgent.push(chunk))
	process.stdin.on('end', () => {
		fromAgent.flush()
		child.stdin.end()
	})
	child.stdin.on('error', () => {})

	child.stdout.setEncoding('utf8')
	child.stdout.on('data', (chunk) => fromChild.push(chunk))
	child.stdout.on('end', () => fromChild.flush())

	child.on('error', (err) => {
		console.error(`${NAME}: cannot start ${command[0]}: ${err.message}`)
		process.exit(127)
	})
	child.on('close', async (code, signal) => {
		// The last denial report races the exit; give in-flight ones a moment.
		await Promise.race([
			Promise.allSettled([...pending]),
			new Promise((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
		])
		process.exit(code ?? (signal ? 1 : 0))
	})
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
		process.on(signal, () => child.kill(signal))
	}
	return null
}

if (require.main === module) {
	const argv = process.argv.slice(2)
	if (argv[0] === '--version') {
		console.log(`${NAME} ${VERSION}`)
		process.exit(0)
	}
	const exitCode = run(argv, process.env)
	if (exitCode !== null) process.exit(exitCode)
}

module.exports = {
	VERSION,
	FORBIDDEN_MESSAGE,
	FORBIDDEN_RPC_CODE,
	loadConfig,
	isAllowed,
	processLine,
	reportDenial,
}
