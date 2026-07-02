#!/usr/bin/env node
// mcp-tool-invocation-emitter: stdio MCP passthrough that taps JSON-RPC frames
// to fire one PostHog `mcp_tool_invocation` per tool call. Wired in front of
// `mcp-remote` so the client → hosted-MCP path stays untouched at the wire
// while the emitter can observe every tools/call round-trip.
//
// Ship metric this feeds (Google Calendar bet):
//   event = mcp_tool_invocation
//   properties = { tool_provider, tool_name, outcome ∈ {success,error},
//                  error_code (auth_revoked on revoked grant, else a short
//                  reason string; null on success), workspace_id }
// The bet guardrail runs
//   countIf(outcome='error' AND error_code='auth_revoked') / countIf(outcome='success')
// so `auth_revoked` MUST be the exact literal set on the revoked-grant path.

import { spawn } from 'node:child_process'
import readline from 'node:readline'

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// Hardcoded per-provider allowlist. Anything outside it never emits — even if a
// future mcp-remote version starts serving unrelated tool_names through the
// same transport, the ship metric stays scoped to the bet's six locked tools.
export const ALLOWLIST_BY_PROVIDER = {
	'google-calendar': new Set([
		'list_calendars',
		'list_calendar_events',
		'get_free_busy',
		'create_event',
		'update_event',
		'send_rsvp',
	]),
}

/**
 * Classify a JSON-RPC response into { outcome, errorCode }.
 * Two failure surfaces to normalise:
 *   1. JSON-RPC protocol error   → msg.error present
 *   2. MCP tool-level error       → msg.result.isError === true
 * On either, if the raw payload names a revoked/invalid grant we set
 * error_code='auth_revoked' verbatim so the bet's guardrail query fires.
 */
export function classifyResponse(msg) {
	if (msg?.error) {
		const raw = stringifyErrorPayload(msg.error)
		return { outcome: 'error', errorCode: mapErrorReason(raw, msg.error.code) }
	}
	if (msg?.result?.isError === true) {
		const raw = stringifyErrorPayload(msg.result.content ?? msg.result)
		return { outcome: 'error', errorCode: mapErrorReason(raw, null) }
	}
	return { outcome: 'success', errorCode: null }
}

function stringifyErrorPayload(v) {
	if (v == null) return ''
	if (typeof v === 'string') return v
	try {
		return JSON.stringify(v)
	} catch {
		return String(v)
	}
}

function mapErrorReason(raw, code) {
	const s = String(raw).toLowerCase()
	if (/invalid_grant|auth_revoked|token has been expired or revoked|unauthorized/i.test(s)) {
		return 'auth_revoked'
	}
	if (typeof code === 'number' && code === 401) return 'auth_revoked'
	if (/401\b|unauthenticated/i.test(s)) return 'auth_revoked'
	if (/timeout|timed out/i.test(s)) return 'timeout'
	if (/rate.?limit|429\b/i.test(s)) return 'rate_limited'
	if (/network|econnrefused|enotfound|dns/i.test(s)) return 'network_error'
	return 'tool_error'
}

/**
 * Extract the tool_name from an outgoing JSON-RPC request, if it is a
 * tools/call. Returns null for anything else — including tools/list, initialize,
 * ping, notifications. Notifications have no `id` so never enter the pending map.
 */
export function extractToolCallRequest(msg) {
	if (!msg || msg.jsonrpc !== '2.0') return null
	if (msg.id == null) return null
	if (msg.method !== 'tools/call') return null
	const name = msg.params && typeof msg.params.name === 'string' ? msg.params.name : null
	if (!name) return null
	return { id: msg.id, toolName: name }
}

/**
 * Build the PostHog event body for a settled tool call. Returns null when the
 * tool_name is outside the provider's allowlist so the caller can drop it
 * without emitting anything.
 */
export function buildEventBody({
	apiKey,
	toolProvider,
	toolName,
	workspaceId,
	classification,
	allowlist,
	now,
}) {
	if (!allowlist || !allowlist.has(toolName)) return null
	return {
		api_key: apiKey,
		event: 'mcp_tool_invocation',
		distinct_id: workspaceId || `provider:${toolProvider}`,
		properties: {
			tool_provider: toolProvider,
			tool_name: toolName,
			outcome: classification.outcome,
			error_code: classification.errorCode,
			workspace_id: workspaceId || null,
			$process_person_profile: false,
		},
		timestamp: (now instanceof Date ? now : new Date()).toISOString(),
	}
}

/**
 * Parse a single line of JSON-RPC. Non-JSON lines (mcp-remote diagnostics
 * printed to stdout) return null and the caller ignores them.
 */
export function parseJsonRpcLine(line) {
	const trimmed = String(line).trim()
	if (!trimmed || trimmed[0] !== '{') return null
	try {
		const msg = JSON.parse(trimmed)
		if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return null
		return msg
	} catch {
		return null
	}
}

/**
 * Build the child process argv for mcp-remote. Kept pure so the CLI wire-up is
 * covered by a unit test — a silently-dropped auth header here would break
 * every tool call in prod.
 */
export function buildRemoteArgs({ url, authHeader, extra }) {
	if (!url) throw new Error('mcp-tool-invocation-emitter: missing MCP endpoint URL argument')
	const args = ['-y', 'mcp-remote', url]
	if (authHeader?.trim()) {
		args.push('--header', `Authorization:${authHeader.trim()}`)
	}
	if (Array.isArray(extra) && extra.length) args.push(...extra)
	return args
}

// ── PostHog capture ───────────────────────────────────────────────────────

const CAPTURE_TIMEOUT_MS = 2_000

async function postCapture(host, body, fetchImpl) {
	const doFetch = fetchImpl || globalThis.fetch
	if (!doFetch) return
	const url = `${String(host).replace(/\/$/, '')}/i/v0/e/`
	try {
		await doFetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
		})
	} catch {
		// Fail-open: analytics gaps must never impact the tool call in flight.
	}
}

// ── CLI entry ────────────────────────────────────────────────────────────

async function main() {
	const [, , url, ...extra] = process.argv
	const toolProvider = process.env.MASKIN_TOOL_PROVIDER
	const workspaceId = process.env.MASKIN_WORKSPACE_ID || ''
	const authHeader = process.env.MASKIN_MCP_AUTH_HEADER || ''
	const posthogKey = (process.env.POSTHOG_API_KEY || '').trim()
	const posthogHost = (process.env.POSTHOG_HOST || 'https://eu.i.posthog.com').trim()

	if (!toolProvider || !ENV_KEY_RE.test(toolProvider.replace(/-/g, '_'))) {
		process.stderr.write(
			'[mcp-emitter] MASKIN_TOOL_PROVIDER env var required — refusing to launch\n',
		)
		process.exit(2)
	}
	const allowlist = ALLOWLIST_BY_PROVIDER[toolProvider]
	if (!allowlist) {
		process.stderr.write(
			`[mcp-emitter] no allowlist registered for provider '${toolProvider}' — refusing to launch\n`,
		)
		process.exit(2)
	}

	const child = spawn('npx', buildRemoteArgs({ url, authHeader, extra }), {
		stdio: ['pipe', 'pipe', 'inherit'],
	})

	const pending = new Map()

	// stdin (from MCP client) → child stdin. Tee off each line to sniff for
	// tools/call requests so we can pair the id → tool_name on the way back.
	const stdinRl = readline.createInterface({
		input: process.stdin,
		crlfDelay: Number.POSITIVE_INFINITY,
	})
	stdinRl.on('line', (line) => {
		try {
			child.stdin.write(`${line}\n`)
		} catch {
			// Child died mid-write; parent will exit shortly on child close.
		}
		const msg = parseJsonRpcLine(line)
		const req = extractToolCallRequest(msg)
		if (req) pending.set(req.id, { toolName: req.toolName })
	})
	stdinRl.on('close', () => {
		try {
			child.stdin.end()
		} catch {}
	})

	// child stdout → stdout (to MCP client). Tap each line for responses that
	// match a pending tools/call id and emit a capture per settled call.
	const childRl = readline.createInterface({
		input: child.stdout,
		crlfDelay: Number.POSITIVE_INFINITY,
	})
	childRl.on('line', (line) => {
		process.stdout.write(`${line}\n`)
		const msg = parseJsonRpcLine(line)
		if (!msg || msg.id == null) return
		const entry = pending.get(msg.id)
		if (!entry) return
		pending.delete(msg.id)
		if (!posthogKey) return // fail-open, matches apps/dev/src/lib/analytics/posthog.ts
		const body = buildEventBody({
			apiKey: posthogKey,
			toolProvider,
			toolName: entry.toolName,
			workspaceId,
			classification: classifyResponse(msg),
			allowlist,
		})
		if (!body) return
		void postCapture(posthogHost, body)
	})

	child.on('close', (code) => {
		process.exit(typeof code === 'number' ? code : 0)
	})
	child.on('error', (err) => {
		process.stderr.write(`[mcp-emitter] failed to spawn mcp-remote: ${String(err)}\n`)
		process.exit(1)
	})
}

// Guard so `import` from a test file doesn't spawn a child process.
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
	void main()
}
