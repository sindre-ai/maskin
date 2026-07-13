#!/usr/bin/env node
// GitHub MCP proxy — sits in front of `@modelcontextprotocol/server-github`
// and mints a fresh, narrowed GitHub App installation token per `tools/call`.
//
// Why this exists: the parent bet
// (https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/9e819672-7bcf-4212-b1b2-a88d83a960b5)
// requires per-request narrowing on the API-side MCP surface for the four
// unattended-agent identities. `session-manager.ts` used to spawn the
// upstream server directly with a static container-launch token; API-side
// calls therefore all shared the same install-wide token. This proxy fixes
// that: every `tools/call` hits the Maskin API's mint route with the tool
// name + repo hint, gets a narrowed `ghs_*` back, and only that call sees it.
//
// Configured by session-manager via container env:
//   MASKIN_API_URL           — mint route base (required)
//   MASKIN_API_KEY           — auth for the mint route (required)
//   MASKIN_WORKSPACE_ID      — scopes the mint (required)
//   GITHUB_INTEGRATION_ID    — which GitHub integration to mint against (required)
//
// The proxy handles `initialize` and `tools/list` locally (no spawn, no mint).
// `tools/call` mints a token, spawns the upstream server as an ephemeral
// child with `GITHUB_TOKEN=<narrowed-token>`, forwards the call, and kills
// the child once the response comes back. `notifications/*` are handled
// locally as no-ops so the proxy stays alive across many calls.

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import {
	KNOWN_TOOLS,
	buildInitializeResponse,
	buildMintUrl,
	buildToolsListResponse,
	extractRepoFromArgs,
	formatJsonRpcError,
	formatJsonRpcResult,
} from './github-mcp-proxy-lib.mjs'

const UPSTREAM_SPAWN_TIMEOUT_MS = 20_000

function log(...args) {
	// stderr only — stdout is the MCP stream. Prefix so surrounding container
	// logs stay grep-able.
	process.stderr.write(`[github-mcp-proxy] ${args.join(' ')}\n`)
}

function writeMessage(line) {
	process.stdout.write(line)
}

async function mintNarrowedToken(toolName, repo) {
	const apiBaseUrl = process.env.MASKIN_API_URL
	const apiKey = process.env.MASKIN_API_KEY
	const workspaceId = process.env.MASKIN_WORKSPACE_ID
	const integrationId = process.env.GITHUB_INTEGRATION_ID
	if (!apiBaseUrl || !apiKey || !workspaceId || !integrationId) {
		throw new Error(
			'Missing MASKIN_API_URL / MASKIN_API_KEY / MASKIN_WORKSPACE_ID / GITHUB_INTEGRATION_ID',
		)
	}
	const url = buildMintUrl({ apiBaseUrl, integrationId, toolName, repo })
	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'X-Workspace-Id': workspaceId,
		},
	})
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new Error(`mint route ${res.status}: ${text.slice(0, 500)}`)
	}
	const body = await res.json()
	if (!body?.token) throw new Error('mint response missing token')
	return body.token
}

/**
 * Spawn an ephemeral upstream MCP server, complete the MCP handshake, forward
 * a single tools/call, capture the response, then kill the child. Isolating
 * one call per child lets us swap the auth token per call without dealing
 * with any Octokit-caching quirks in the upstream server.
 */
async function callUpstreamOnce({ token, callRequest }) {
	const child = spawn('npx', ['-y', '@modelcontextprotocol/server-github'], {
		env: { ...process.env, GITHUB_TOKEN: token },
		stdio: ['pipe', 'pipe', 'inherit'],
	})

	let stdoutBuf = ''
	const inflight = new Map() // id -> { resolve, reject }

	child.stdout.setEncoding('utf8')
	child.stdout.on('data', (chunk) => {
		stdoutBuf += chunk
		while (true) {
			const newlineIdx = stdoutBuf.indexOf('\n')
			if (newlineIdx === -1) break
			const raw = stdoutBuf.slice(0, newlineIdx).trim()
			stdoutBuf = stdoutBuf.slice(newlineIdx + 1)
			if (!raw) continue
			let msg
			try {
				msg = JSON.parse(raw)
			} catch {
				continue
			}
			if (msg?.id !== undefined && inflight.has(msg.id)) {
				const { resolve, reject } = inflight.get(msg.id)
				inflight.delete(msg.id)
				if (msg.error) reject(new Error(msg.error.message ?? 'upstream error'))
				else resolve(msg.result)
			}
		}
	})

	const spawnFailure = new Promise((_, reject) => {
		child.once('error', (err) => reject(new Error(`upstream spawn failed: ${err.message}`)))
		child.once('exit', (code, signal) => {
			for (const { reject } of inflight.values()) {
				reject(new Error(`upstream exited (code=${code} signal=${signal}) before responding`))
			}
			inflight.clear()
		})
	})

	function sendRequest(id, method, params) {
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
		return Promise.race([
			new Promise((resolve, reject) => inflight.set(id, { resolve, reject })),
			spawnFailure,
			(async () => {
				await delay(UPSTREAM_SPAWN_TIMEOUT_MS)
				throw new Error(`upstream ${method} timed out after ${UPSTREAM_SPAWN_TIMEOUT_MS}ms`)
			})(),
		])
	}

	function sendNotification(method, params) {
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
	}

	try {
		await sendRequest(-1, 'initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'maskin-github-mcp-proxy', version: '0.1.0' },
		})
		sendNotification('notifications/initialized', {})
		const result = await sendRequest(callRequest.id ?? Date.now(), 'tools/call', callRequest.params)
		return result
	} finally {
		try {
			child.stdin.end()
		} catch {}
		if (!child.killed) child.kill('SIGTERM')
	}
}

async function handleToolsCall(message) {
	const params = message.params ?? {}
	const toolName = params.name
	if (typeof toolName !== 'string' || !toolName) {
		writeMessage(formatJsonRpcError(message.id, -32602, 'tools/call missing name'))
		return
	}
	if (!Object.hasOwn(KNOWN_TOOLS, toolName)) {
		writeMessage(
			formatJsonRpcError(
				message.id,
				-32601,
				`Unknown GitHub tool "${toolName}" — not in the scope mapping. See TOOL_PERMISSIONS in apps/dev/src/lib/integrations/providers/github/scope.ts.`,
			),
		)
		return
	}
	const repo = KNOWN_TOOLS[toolName] === 'both' ? extractRepoFromArgs(params.arguments) : undefined

	let token
	try {
		token = await mintNarrowedToken(toolName, repo)
	} catch (err) {
		// Fallback to the container-launch GITHUB_TOKEN so a transient mint-route
		// outage doesn't strand the agent mid-session. Loud log so the fallback
		// is visible in container logs — the whole point of the proxy is to
		// avoid the install-wide token, so falling back is a real regression
		// we want to notice. Parent bet DoD explicitly permits this as the
		// downgraded shape for legacy transports; here it's the last resort.
		const fallback = process.env.GITHUB_TOKEN
		if (!fallback) {
			log(`mint failed with no fallback: ${err instanceof Error ? err.message : String(err)}`)
			writeMessage(
				formatJsonRpcError(
					message.id,
					-32000,
					`GitHub token mint failed: ${err instanceof Error ? err.message : String(err)}`,
				),
			)
			return
		}
		log(
			`mint failed, falling back to container GITHUB_TOKEN (install-wide): ${err instanceof Error ? err.message : String(err)}`,
		)
		token = fallback
	}

	try {
		const result = await callUpstreamOnce({ token, callRequest: message })
		writeMessage(formatJsonRpcResult(message.id, result))
	} catch (err) {
		log(`upstream call failed: ${err instanceof Error ? err.message : String(err)}`)
		writeMessage(
			formatJsonRpcError(
				message.id,
				-32000,
				`Upstream GitHub MCP call failed: ${err instanceof Error ? err.message : String(err)}`,
			),
		)
	}
}

function handleInitialize(message) {
	writeMessage(
		formatJsonRpcResult(message.id, buildInitializeResponse(message.params?.protocolVersion)),
	)
}

function handleToolsList(message) {
	writeMessage(formatJsonRpcResult(message.id, buildToolsListResponse()))
}

async function dispatch(message) {
	if (message.method === 'initialize') return handleInitialize(message)
	if (message.method === 'tools/list') return handleToolsList(message)
	if (message.method === 'tools/call') return handleToolsCall(message)
	if (typeof message.method === 'string' && message.method.startsWith('notifications/')) {
		return
	}
	if (message.id !== undefined) {
		writeMessage(
			formatJsonRpcError(
				message.id,
				-32601,
				`Method "${message.method}" not supported by github-mcp-proxy`,
			),
		)
	}
}

async function main() {
	process.stdin.setEncoding('utf8')
	let buffer = ''
	for await (const chunk of process.stdin) {
		buffer += chunk
		while (true) {
			const newlineIdx = buffer.indexOf('\n')
			if (newlineIdx === -1) break
			const raw = buffer.slice(0, newlineIdx).trim()
			buffer = buffer.slice(newlineIdx + 1)
			if (!raw) continue
			let msg
			try {
				msg = JSON.parse(raw)
			} catch (err) {
				log(`ignoring malformed JSON-RPC line: ${err instanceof Error ? err.message : err}`)
				continue
			}
			await dispatch(msg).catch((err) => {
				log(`dispatch crash: ${err instanceof Error ? err.message : err}`)
				if (msg?.id !== undefined) {
					writeMessage(
						formatJsonRpcError(
							msg.id,
							-32000,
							`Internal proxy error: ${err instanceof Error ? err.message : String(err)}`,
						),
					)
				}
			})
		}
	}
}

main().catch((err) => {
	log(`fatal: ${err instanceof Error ? err.stack : err}`)
	process.exit(1)
})
