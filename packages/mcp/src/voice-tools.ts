/**
 * The tool surface of a Live (voice) call: every tool the MCP server registers that the
 * model may call (app-only tools are left out), as chat gets them, plus the tools of any extra MCP servers the caller
 * hands in (the ones attached to the agent).
 *
 * Nothing is redefined here. `createMcpServer` is the single source of truth
 * for the Maskin tools, and a voice call reads it through an in-memory MCP
 * client, so the names, descriptions and JSON schemas pinned onto the Realtime
 * session are the ones `tools/list` returns to any other MCP client, and a call
 * is validated and run by the SDK exactly as it is for chat. Extra servers are
 * reached over HTTP/SSE the same way and their tools are listed as they report
 * them, with the server name in front so they cannot collide.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { READ_ONLY_TOOLS } from './annotations.js'
import type { InvokeTool } from './invoke.js'
import { type McpConfig, createMcpServer } from './server.js'

/** A tool in the shape the OpenAI Realtime session expects in `session.tools`. */
export interface VoiceRealtimeTool {
	type: 'function'
	name: string
	description: string
	parameters: Record<string, unknown>
}

/** An already-resolved remote MCP server (placeholders filled, credentials in place). */
export interface VoiceExternalMcpServer {
	url: string
	headers?: Record<string, string>
	transport?: 'http' | 'sse'
}

export interface VoiceToolkit {
	/** Every registered MCP tool, as Realtime function definitions. */
	tools: VoiceRealtimeTool[]
	/** Runs a tool through the MCP SDK (input validation included). */
	invokeTool: InvokeTool
	/**
	 * Tools that only read, by Realtime function name: the platform tools in
	 * READ_ONLY_TOOLS (the table chat uses) plus tools of the extra servers that
	 * declare readOnlyHint. Every other tool is a write.
	 */
	readOnlyTools: ReadonlySet<string>
	/** Names of extra servers that could not be reached, so their tools are missing. */
	unreachableServers: string[]
	/** Closes the connections to the extra servers. */
	close: () => Promise<void>
}

/** How long one extra server gets to connect and list its tools. */
export const VOICE_EXTERNAL_MCP_CONNECT_TIMEOUT_MS = 5000
/** The Realtime API limits a function name to this many characters. */
const MAX_TOOL_NAME_LENGTH = 64

/**
 * True for a tool the server registers for an MCP App's own buttons only (`visibility: ['app']`),
 * such as approve_object_draft. The model cannot complete it (the server refuses any caller that
 * is not a person), so offering it on a call would ask the person for a yes to something that
 * then fails.
 */
function isAppOnlyTool(tool: { _meta?: Record<string, unknown> }): boolean {
	const ui = tool._meta?.ui as { visibility?: unknown } | undefined
	return Array.isArray(ui?.visibility) && !ui.visibility.includes('model')
}

async function listAllTools(client: Client) {
	const out = []
	let cursor: string | undefined
	do {
		const page = await client.listTools(cursor ? { cursor } : undefined)
		out.push(...page.tools)
		cursor = page.nextCursor
	} while (cursor)
	return out
}

function realtimeName(server: string, tool: string, taken: Set<string>): string {
	const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')
	const base = `${safe(server)}__${safe(tool)}`.slice(0, MAX_TOOL_NAME_LENGTH)
	let name = base
	for (let n = 2; taken.has(name); n++) {
		const suffix = `_${n}`
		name = `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`
	}
	taken.add(name)
	return name
}

/**
 * Never follow a redirect: the address was checked before the call, and a
 * redirect would carry the request (and its credentials) somewhere unchecked.
 */
const noRedirectFetch = (input: string | URL, init?: RequestInit) =>
	fetch(input, { ...init, redirect: 'manual' })

async function connectExternal(spec: VoiceExternalMcpServer): Promise<Client> {
	const url = new URL(spec.url)
	const requestInit = { headers: spec.headers ?? {} }
	const transport =
		spec.transport === 'sse'
			? new SSEClientTransport(url, { requestInit, fetch: noRedirectFetch })
			: new StreamableHTTPClientTransport(url, { requestInit, fetch: noRedirectFetch })
	const client = new Client({ name: 'maskin-voice', version: '0.1.0' })
	try {
		await client.connect(transport)
	} catch (err) {
		await client.close().catch(() => {})
		throw err
	}
	return client
}

export async function createVoiceToolkit(
	config: McpConfig,
	externalServers: Record<string, VoiceExternalMcpServer> = {},
): Promise<VoiceToolkit> {
	const server = createMcpServer(config)
	const client = new Client({ name: 'maskin-voice', version: '0.1.0' })
	const externalClients: Client[] = []
	try {
		return await buildToolkit(server, client, externalClients, externalServers)
	} catch (err) {
		// Setup failed halfway: close everything already opened.
		await Promise.allSettled([
			client.close(),
			server.close(),
			...externalClients.map((c) => c.close()),
		])
		throw err
	}
}

async function buildToolkit(
	server: ReturnType<typeof createMcpServer>,
	client: Client,
	externalClients: Client[],
	externalServers: Record<string, VoiceExternalMcpServer>,
): Promise<VoiceToolkit> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

	const tools: VoiceRealtimeTool[] = []
	const taken = new Set<string>()
	for (const tool of await listAllTools(client)) {
		if (isAppOnlyTool(tool)) continue
		taken.add(tool.name)
		tools.push({
			type: 'function',
			name: tool.name,
			description: tool.description ?? '',
			parameters: tool.inputSchema,
		})
	}

	// realtime function name -> where to send the call and what the server calls it
	const external = new Map<string, { client: Client; tool: string }>()
	const readOnlyTools = new Set<string>(READ_ONLY_TOOLS)
	const unreachableServers: string[] = []
	await Promise.all(
		Object.entries(externalServers).map(async ([serverName, spec]) => {
			let connected: Client | null = null
			let timedOut = false
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				const attempt = (async () => {
					const c = await connectExternal(spec)
					connected = c
					// Connected after the deadline: nobody is waiting for it any more.
					if (timedOut) {
						await c.close().catch(() => {})
						throw new Error('timed out')
					}
					return { client: c, tools: await listAllTools(c) }
				})()
				// If the timeout wins the race, this keeps the late result from being an unhandled rejection.
				attempt.catch(() => {})
				const listed = await Promise.race([
					attempt,
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							timedOut = true
							reject(new Error('timed out'))
						}, VOICE_EXTERNAL_MCP_CONNECT_TIMEOUT_MS)
					}),
				])
				clearTimeout(timer)
				externalClients.push(listed.client)
				for (const tool of listed.tools) {
					if (isAppOnlyTool(tool)) continue
					const name = realtimeName(serverName, tool.name, taken)
					external.set(name, { client: listed.client, tool: tool.name })
					if (tool.annotations?.readOnlyHint === true) readOnlyTools.add(name)
					tools.push({
						type: 'function',
						name,
						description: tool.description ?? '',
						parameters: tool.inputSchema,
					})
				}
			} catch (err) {
				clearTimeout(timer)
				unreachableServers.push(serverName)
				console.error(
					`[MCP] Voice could not use server "${serverName}":`,
					err instanceof Error ? err.message : err,
				)
				;(connected as Client | null)?.close().catch(() => {})
			}
		}),
	)

	return {
		tools,
		readOnlyTools,
		unreachableServers,
		invokeTool: (name, args) => {
			const target = external.get(name)
			return (target?.client ?? client).callTool({
				name: target?.tool ?? name,
				arguments: (args ?? {}) as Record<string, unknown>,
			})
		},
		close: async () => {
			await Promise.allSettled([client, ...externalClients].map((c) => c.close()))
		},
	}
}
