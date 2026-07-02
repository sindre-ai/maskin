// Client-side stdio wrapper around `mcp-remote` that emits one PostHog
// `mcp_tool_invocation` per tool call so the Google Calendar bet's ship metric
// and auth_revoked guardrail can read per-tool-call granularity from prod.
//
// Layout: `claude-cli --mcp-config …` spawns THIS script as a stdio MCP
// server. We in turn spawn `npx -y mcp-remote <url>` and pipe stdio through it
// verbatim, so the client sees an ordinary hosted-MCP endpoint. In parallel we
// parse each JSON-RPC line, pair `tools/call` requests with their responses by
// id, and fire one PostHog capture per pairing — only for the tool_name
// allowlist locked by the Google Calendar bet.
//
// The MCP protocol on stdio is newline-delimited JSON-RPC 2.0 per the
// 2024-11-05 spec (each message is one line on stdout). We split on `\n`,
// forward each complete line to the peer verbatim, and inspect a copy.

import { spawn } from 'node:child_process'
import process from 'node:process'

// Per-provider allowlist of tool_names that may emit through this path. Any
// tool_name outside the set is dropped (not captured), so unrelated MCP tools
// the client fires — either from the same server or from an accidental
// wildcard — can't leak into the metric.
export const ALLOWLISTS = {
	'google-calendar': new Set([
		'list_calendars',
		'list_calendar_events',
		'get_free_busy',
		'create_event',
		'update_event',
		'send_rsvp',
	]),
}

// Map a provider name to the env var holding the bearer token to forward to
// mcp-remote. Mirrors the `envKey` on each provider's `config.ts`.
const PROVIDER_TOKEN_ENV = {
	'google-calendar': 'GOOGLE_CALENDAR_TOKEN',
}

const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com'
const CAPTURE_TIMEOUT_MS = 2_000

/**
 * Classify a JSON-RPC error object into a short `error_code` string. The bet's
 * guardrail reads `outcome='error' AND error_code='auth_revoked'`, so this
 * function is load-bearing for the guardrail — anything that looks like a
 * revoked Google grant must resolve to exactly `auth_revoked`.
 */
export function classifyError(error) {
	if (!error || typeof error !== 'object') return 'unknown'
	const msg = typeof error.message === 'string' ? error.message : ''
	let dataStr = ''
	try {
		dataStr = error.data !== undefined ? JSON.stringify(error.data) : ''
	} catch {
		dataStr = ''
	}
	const combined = `${msg} ${dataStr}`.toLowerCase()
	if (
		combined.includes('unauthorized') ||
		combined.includes('revoked') ||
		combined.includes('invalid_grant') ||
		combined.includes('token_expired') ||
		combined.includes('token expired') ||
		combined.includes('401')
	) {
		return 'auth_revoked'
	}
	if (typeof error.code === 'number' || typeof error.code === 'string') {
		return `mcp_${error.code}`
	}
	const first = msg.split(/[\s:]+/).filter(Boolean)[0]
	return first ? first.toLowerCase().slice(0, 32) : 'unknown'
}

/** True if a tool_name is on the provider's allowlist. */
export function isTrackable(toolProvider, toolName) {
	const set = ALLOWLISTS[toolProvider]
	return !!set && !!toolName && set.has(toolName)
}

/**
 * Build the PostHog `/i/v0/e/` body for one `mcp_tool_invocation` event.
 * `$process_person_profile:false` mirrors the developer_session_completed
 * pattern so PostHog doesn't create a Person profile per workspace_id.
 */
export function buildPosthogPayload({
	apiKey,
	toolProvider,
	toolName,
	outcome,
	errorCode,
	workspaceId,
	timestamp,
}) {
	return {
		api_key: apiKey,
		event: 'mcp_tool_invocation',
		distinct_id: workspaceId || 'unknown',
		properties: {
			tool_provider: toolProvider,
			tool_name: toolName,
			outcome,
			error_code: errorCode ?? null,
			workspace_id: workspaceId || null,
			$process_person_profile: false,
		},
		timestamp: timestamp ?? new Date().toISOString(),
	}
}

/**
 * Best-effort PostHog capture. Never throws, never blocks. On a missing
 * `POSTHOG_API_KEY` (local dev, CI without analytics) we return silently — the
 * client still gets its tool response.
 */
export async function capture({ toolProvider, toolName, outcome, errorCode, env = process.env }) {
	const apiKey = env.POSTHOG_API_KEY?.trim()
	if (!apiKey) return
	const host = (env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/$/, '')
	const workspaceId = env.MASKIN_WORKSPACE_ID?.trim() || ''
	const payload = buildPosthogPayload({
		apiKey,
		toolProvider,
		toolName,
		outcome,
		errorCode,
		workspaceId,
	})
	try {
		await fetch(`${host}/i/v0/e/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
		})
	} catch {
		// Fail-open: telemetry never affects the client's tool call.
	}
}

/**
 * Factory that returns a JSON-RPC pairing interceptor. `onClientMessage` is
 * called for every parsed message we see on the wire from client → server;
 * `onServerMessage` for every one on server → client. Both are pure — they
 * only invoke `emit(...)` when a `tools/call` response completes and the
 * tool_name is on the provider's allowlist.
 *
 * Kept as a factory + pure callbacks so the transport-level test can drive it
 * without spawning a real child process.
 */
export function createInterceptor({ toolProvider, emit }) {
	const pending = new Map()

	function trackRequest(msg) {
		if (!msg || typeof msg !== 'object') return
		if (msg.method !== 'tools/call') return
		if (msg.id === undefined || msg.id === null) return
		const toolName = msg.params && typeof msg.params === 'object' ? msg.params.name : undefined
		if (typeof toolName !== 'string') return
		pending.set(msg.id, { toolName })
	}

	function resolveResponse(msg) {
		if (!msg || typeof msg !== 'object') return
		if (msg.id === undefined || msg.id === null) return
		if (!pending.has(msg.id)) return
		const { toolName } = pending.get(msg.id)
		pending.delete(msg.id)
		if (!isTrackable(toolProvider, toolName)) return

		let outcome = 'success'
		let errorCode = null
		if (msg.error) {
			outcome = 'error'
			errorCode = classifyError(msg.error)
		} else if (msg.result && typeof msg.result === 'object' && msg.result.isError === true) {
			// MCP tool-level error surfaces on result.isError (not on the JSON-RPC
			// error channel). Extract a short reason from result.content[0].text
			// when present so the guardrail can still see auth_revoked failures
			// that the server returns as tool errors.
			outcome = 'error'
			const firstText = Array.isArray(msg.result.content)
				? msg.result.content.find((c) => c && c.type === 'text')?.text
				: undefined
			errorCode = classifyError({ message: firstText ?? 'tool_error' })
		}

		try {
			emit({ toolProvider, toolName, outcome, errorCode })
		} catch {
			// Fail-open: never let telemetry break the proxy.
		}
	}

	function onMessage(msg, direction) {
		// Handle JSON-RPC batch arrays.
		const list = Array.isArray(msg) ? msg : [msg]
		for (const m of list) {
			if (direction === 'client') trackRequest(m)
			else resolveResponse(m)
		}
	}

	return {
		onClientMessage: (msg) => onMessage(msg, 'client'),
		onServerMessage: (msg) => onMessage(msg, 'server'),
	}
}

/**
 * Newline-delimited JSON splitter. `onLine` fires for every complete line
 * (without the trailing newline). Partial trailing data stays buffered.
 * Simpler than pulling in `readline` and easier to test in-process.
 */
export function createLineSplitter(onLine) {
	let buf = ''
	return {
		write(chunk) {
			buf += chunk.toString('utf8')
			let idx = buf.indexOf('\n')
			while (idx !== -1) {
				onLine(buf.slice(0, idx))
				buf = buf.slice(idx + 1)
				idx = buf.indexOf('\n')
			}
		},
		flush() {
			if (buf.length > 0) {
				onLine(buf)
				buf = ''
			}
		},
	}
}

/**
 * Wire stdio ↔ child process. Verbatim passthrough on the bytes — we split
 * only for interception, then write the exact original chunks downstream so
 * the JSON-RPC framing the client and server agreed on stays byte-perfect.
 */
function runProxy({ toolProvider, upstreamUrl, env, argv }) {
	const tokenEnv = PROVIDER_TOKEN_ENV[toolProvider]
	const token = tokenEnv ? env[tokenEnv] : ''

	const args = ['-y', 'mcp-remote', upstreamUrl]
	if (token) {
		args.push('--header', `Authorization:Bearer ${token}`)
	}
	// Any extra argv passed after `--` on the wrapper CLI is forwarded to
	// mcp-remote (e.g., custom headers, transport flags).
	if (argv && argv.length > 0) {
		args.push(...argv)
	}

	const child = spawn('npx', args, {
		stdio: ['pipe', 'pipe', 'inherit'],
		env,
	})

	const interceptor = createInterceptor({
		toolProvider,
		emit: (payload) => {
			// Fire-and-forget — capture() awaits internally on its own timeout.
			void capture({ ...payload, env })
		},
	})

	// stdin → child.stdin, verbatim; splitter parses in parallel.
	const clientSplitter = createLineSplitter((line) => {
		if (!line) return
		try {
			interceptor.onClientMessage(JSON.parse(line))
		} catch {
			// Non-JSON line — pass through untouched.
		}
	})
	process.stdin.on('data', (chunk) => {
		child.stdin.write(chunk)
		clientSplitter.write(chunk)
	})
	process.stdin.on('end', () => {
		clientSplitter.flush()
		child.stdin.end()
	})

	// child.stdout → stdout, verbatim; splitter parses in parallel.
	const serverSplitter = createLineSplitter((line) => {
		if (!line) return
		try {
			interceptor.onServerMessage(JSON.parse(line))
		} catch {
			// Non-JSON line — pass through untouched.
		}
	})
	child.stdout.on('data', (chunk) => {
		process.stdout.write(chunk)
		serverSplitter.write(chunk)
	})
	child.stdout.on('end', () => {
		serverSplitter.flush()
	})

	child.on('exit', (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal)
			return
		}
		process.exit(code ?? 0)
	})

	child.on('error', (err) => {
		process.stderr.write(`[mcp-emitter-wrapper] child spawn error: ${err.message}\n`)
		process.exit(127)
	})
}

// CLI entry point. Skipped when the module is imported (e.g., from vitest) —
// the runtime script imports and starts the proxy explicitly below.
export function parseArgs(argv) {
	// argv layout: [node, script, toolProvider, upstreamUrl, ...extra]
	if (argv.length < 4) {
		throw new Error(
			'usage: mcp-emitter-wrapper.mjs <tool_provider> <upstream_url> [extra mcp-remote args...]',
		)
	}
	const [, , toolProvider, upstreamUrl, ...extra] = argv
	if (!ALLOWLISTS[toolProvider]) {
		throw new Error(`unknown tool_provider: ${toolProvider}`)
	}
	if (!/^https?:\/\//.test(upstreamUrl)) {
		throw new Error(`invalid upstream_url: ${upstreamUrl}`)
	}
	return { toolProvider, upstreamUrl, extra }
}

// Run only when invoked as a CLI, not when imported.
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
	try {
		const { toolProvider, upstreamUrl, extra } = parseArgs(process.argv)
		runProxy({ toolProvider, upstreamUrl, env: process.env, argv: extra })
	} catch (err) {
		process.stderr.write(`[mcp-emitter-wrapper] ${err.message}\n`)
		process.exit(2)
	}
}
