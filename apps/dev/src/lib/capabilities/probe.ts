import type { Database } from '@maskin/db'
import { tools as builtinTools } from '@maskin/mcp'
import { getLinkedInMcpInstancesForIntegration } from '@maskin/mcp/linkedin'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { isAuthRevokedError } from '../integrations/errors'
import { TokenManager } from '../integrations/oauth/token-manager'
import { GITHUB_MCP_SERVER_SPEC } from '../integrations/providers/github/config'
import { createGoogleMeetMcpServer } from '../integrations/providers/google-meet/mcp-server'
import { createLinkedInMcpServer } from '../integrations/providers/linkedin-unipile/mcp-server'
import { createSlackMcpServer } from '../integrations/providers/slack/mcp-server'
import { getProvider } from '../integrations/registry'
import { hashServerSpec, hashToolSchema } from './schema-hash'
import type { CapabilitySource } from './sources'

export interface ProbeResult {
	/** Tool name to input-schema hash. */
	tools: Record<string, string>
	/** Hash of a stdio server spec; null for sources probed over a transport. */
	specHash: string | null
}

/** Injectable so tests can stub the network and the in-process servers. */
export type ProbeFn = (
	db: Database,
	workspaceId: string,
	source: CapabilitySource,
) => Promise<ProbeResult>

const HOSTED_TIMEOUT_MS = 10_000
const HOSTED_ATTEMPTS = 2
const MAX_LIST_PAGES = 20

interface ListedTool {
	name: string
	inputSchema?: unknown
}

async function listAllTools(client: Client, timeout?: number): Promise<ListedTool[]> {
	const listed: ListedTool[] = []
	let cursor: string | undefined
	for (let page = 0; page < MAX_LIST_PAGES; page++) {
		const res = await client.listTools(
			cursor ? { cursor } : undefined,
			timeout ? { timeout } : undefined,
		)
		listed.push(...res.tools)
		if (!res.nextCursor) return listed
		cursor = res.nextCursor
	}
	return listed
}

function hashListed(listed: ListedTool[]): Record<string, string> {
	const out: Record<string, string> = {}
	for (const tool of listed) out[tool.name] = hashToolSchema(tool.inputSchema)
	return out
}

/** Class A: the built-in tools const. Changes only on deploy. */
export function probeBuiltin(): ProbeResult {
	const out: Record<string, string> = {}
	for (const [name, def] of Object.entries(builtinTools)) {
		const json = toJsonSchemaCompat(def.inputSchema as Parameters<typeof toJsonSchemaCompat>[0])
		out[name] = hashToolSchema(json)
	}
	return { tools: out, specHash: null }
}

/** Class B: ask an in-process MCP server for tools/list over a linked in-memory pair. */
async function listInMemory(server: McpServer): Promise<Record<string, string>> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	const client = new Client({ name: 'capability-scan', version: '1.0.0' }, { capabilities: {} })
	await server.connect(serverTransport)
	try {
		await client.connect(clientTransport)
		return hashListed(await listAllTools(client))
	} finally {
		await client.close().catch(() => undefined)
		await server.close().catch(() => undefined)
	}
}

async function probeInProcess(
	db: Database,
	workspaceId: string,
	source: CapabilitySource,
): Promise<ProbeResult> {
	let server: McpServer
	switch (source.provider) {
		case 'slack':
			// Stub credentials: registering tools makes no Slack call.
			server = createSlackMcpServer({
				botToken: 'xoxb-capability-scan-stub',
				integrationId: source.integrationId ?? source.entityId,
				agentLabel: 'capability-scan',
				workspaceId,
				actorId: workspaceId,
			})
			break
		case 'google-meet':
			server = createGoogleMeetMcpServer({ db, workspaceId })
			break
		case 'linkedin-unipile': {
			const instances = getLinkedInMcpInstancesForIntegration(source.integrationId ?? '')
			// The registry is filled at connect time and at boot. An empty registry for
			// an active credential means "not repopulated yet", never "no tools".
			if (instances.length === 0) throw new Error('LinkedIn registry has no instances yet')
			server = createLinkedInMcpServer({ db, actorId: workspaceId, workspaceId }, instances)
			break
		}
		default:
			throw new Error(`No in-process probe for provider ${source.provider}`)
	}
	return { tools: await listInMemory(server), specHash: null }
}

/** Class C, hosted HTTP: one authenticated tools/list with the customer's own token. */
async function probeHosted(db: Database, source: CapabilitySource): Promise<ProbeResult> {
	if (!source.provider || !source.integrationId)
		throw new Error('Hosted source without integration')
	const provider = getProvider(source.provider)
	const mcp = provider.config.mcp
	const spec = mcp?.server
	if (!mcp || spec?.type !== 'http')
		throw new Error(`Provider ${source.provider} has no http server`)

	// An auth-revoked error is not retried: the integration needs a reconnect.
	const token = await new TokenManager().getValidToken(db, source.integrationId, provider)
	const expand = (text: string) => text.split(`\${${mcp.envKey}}`).join(token)
	const headers: Record<string, string> = {}
	for (const [name, value] of Object.entries(spec.headers ?? {})) headers[name] = expand(value)

	let lastError: unknown
	for (let attempt = 0; attempt < HOSTED_ATTEMPTS; attempt++) {
		const client = new Client({ name: 'capability-scan', version: '1.0.0' }, { capabilities: {} })
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL(expand(spec.url)), { requestInit: { headers } }),
				{ timeout: HOSTED_TIMEOUT_MS },
			)
			return { tools: hashListed(await listAllTools(client, HOSTED_TIMEOUT_MS)), specHash: null }
		} catch (err) {
			if (isAuthRevokedError(err)) throw err
			lastError = err
		} finally {
			await client.close().catch(() => undefined)
		}
	}
	throw lastError instanceof Error ? lastError : new Error('Hosted probe failed')
}

/**
 * Class C, stdio (GitHub): never spawned. Spawning would hand third-party code
 * a child process, and bridge.ts passes the whole API environment to its child.
 * Only the spec hash (command plus args, where a pinned version shows up) is kept.
 */
function probeStdioSpec(): ProbeResult {
	return { tools: {}, specHash: hashServerSpec(GITHUB_MCP_SERVER_SPEC) }
}

export const probeSource: ProbeFn = async (db, workspaceId, source) => {
	switch (source.probe) {
		case 'builtin':
			return probeBuiltin()
		case 'in_process':
			return probeInProcess(db, workspaceId, source)
		case 'hosted_http':
			return probeHosted(db, source)
		case 'stdio_spec':
			return probeStdioSpec()
	}
}
