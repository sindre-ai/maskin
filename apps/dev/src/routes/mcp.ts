import { validateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { createMcpServer } from '@maskin/mcp'
import { resolveWebAppBaseUrl } from '@maskin/shared'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Hono } from 'hono'
import {
	type JsonRpcErrorLike,
	type McpMisfire,
	classifyMcpError,
	recordMcpMisfire,
	requestedShape,
} from '../lib/analytics/mcp-misfire'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'

// Only `db` is set on the /mcp path — the auth middleware runs under /api/*.
type Env = {
	Variables: {
		db: Database
	}
}

const app = new Hono<Env>()

interface JsonRpcMessage {
	jsonrpc?: string
	id?: string | number | null
	method?: string
	params?: {
		name?: string
		arguments?: unknown
	}
	// The MCP SDK surfaces `tools/call` failures as `result.isError: true`
	// with the human-readable error text in `content[0].text` — not as a
	// top-level JSON-RPC `error` field. `extractError` normalizes both.
	result?: {
		isError?: boolean
		content?: Array<{ type?: string; text?: string }>
	}
	error?: JsonRpcErrorLike
}

app.post('/', async (c) => {
	const url = new URL(c.req.url, 'http://localhost')
	const apiKey =
		c.req.header('Authorization')?.replace('Bearer ', '') ?? url.searchParams.get('key') ?? ''
	const workspaceId = c.req.header('X-Workspace-Id') ?? url.searchParams.get('workspace') ?? ''
	const mcpConfig = {
		apiBaseUrl: `http://localhost:${Number(process.env.PORT) || 3000}`,
		apiKey,
		defaultWorkspaceId: workspaceId,
		transport: 'http' as const,
		webAppBaseUrl: resolveWebAppBaseUrl(process.env),
	}
	const mcpServer = createMcpServer(mcpConfig)
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})

	const nodeRes = (c.env as Record<string, unknown>).outgoing as import('node:http').ServerResponse
	const nodeReq = (c.env as Record<string, unknown>).incoming as import('node:http').IncomingMessage

	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid JSON in request body'), 400)
	}
	const method =
		(body as Record<string, unknown>)?.method ??
		(Array.isArray(body) ? body.map((b: { method?: string }) => b.method) : 'unknown')
	console.log(`[MCP] POST /mcp — method: ${JSON.stringify(method)}`)

	// Wrap the outgoing Node response so we can sniff the JSON-RPC body for
	// misfire classification after the SDK writes it. Emission is best-effort
	// (see `emitMcpMisfires`) — a capture or parse failure must never break
	// the MCP request path.
	const captured = wrapResponseCapture(nodeRes)

	await mcpServer.connect(transport)
	await transport.handleRequest(nodeReq, nodeRes, body)

	// Fire-and-forget: classify any JSON-RPC errors in the response and emit
	// one PostHog event per real misfire.
	const sessionCorrelationId = c.req.header('Mcp-Session-Id') ?? null
	void emitMcpMisfires({
		db: c.get('db'),
		apiKey,
		workspaceId,
		requestBody: body,
		responseBytes: captured.consume(),
		sessionCorrelationId,
	})

	// transport.handleRequest already wrote the response to nodeRes.
	// Signal @hono/node-server to skip writing headers again.
	return new Response(null, {
		headers: { 'x-hono-already-sent': '1' },
	})
})

// Reject GET/DELETE on /mcp — server doesn't support server-initiated SSE streams
app.get('/', (c) => {
	return c.text('Method Not Allowed', 405)
})

app.delete('/', (c) => {
	return c.text('Method Not Allowed', 405)
})

export default app

// ── Response capture ────────────────────────────────────────────────────
//
// StreamableHTTPServerTransport writes the JSON-RPC response(s) directly to
// the Node `ServerResponse` (bypassing Hono). We monkey-patch `write` and
// `end` to snapshot the bytes as they flow out, then hand the buffer to the
// misfire classifier once the transport is done.

function wrapResponseCapture(res: import('node:http').ServerResponse) {
	const chunks: Buffer[] = []
	const capture = (chunk: unknown) => {
		if (chunk === undefined || chunk === null) return
		if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
		else if (Buffer.isBuffer(chunk)) chunks.push(chunk)
		else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk))
	}

	const originalWrite = res.write.bind(res)
	const originalEnd = res.end.bind(res)

	// biome-ignore lint/suspicious/noExplicitAny: ServerResponse.write/end have overloaded signatures; wrapper is a pure pass-through.
	res.write = ((...args: any[]) => {
		capture(args[0])
		return originalWrite(...(args as Parameters<typeof originalWrite>))
	}) as typeof res.write
	// biome-ignore lint/suspicious/noExplicitAny: see above.
	res.end = ((...args: any[]) => {
		capture(args[0])
		return originalEnd(...(args as Parameters<typeof originalEnd>))
	}) as typeof res.end

	return {
		consume(): Buffer {
			return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)
		},
	}
}

// ── Misfire emission ────────────────────────────────────────────────────

interface EmitMcpMisfiresArgs {
	db: Database | undefined
	apiKey: string
	workspaceId: string
	requestBody: unknown
	responseBytes: Buffer
	sessionCorrelationId: string | null
}

async function emitMcpMisfires(args: EmitMcpMisfiresArgs): Promise<void> {
	try {
		const responses = parseJsonRpcResponses(args.responseBytes)
		const errored = responses
			.map((r) => ({ message: r, error: extractError(r) }))
			.filter((r): r is { message: JsonRpcMessage; error: JsonRpcErrorLike } => Boolean(r.error))
		if (errored.length === 0) return

		const requestsById = indexRequestsById(args.requestBody)
		const agentActorId =
			args.apiKey && args.db ? await resolveAgentActorId(args.db, args.apiKey) : null

		for (const { message, error } of errored) {
			const kind = classifyMcpError(error)
			if (!kind) continue
			const request = message.id != null ? requestsById.get(String(message.id)) : undefined
			const toolName = extractToolName(request, error.message)
			if (!toolName) continue
			const shape = requestedShape(request?.params?.arguments)
			const misfire: McpMisfire = {
				kind,
				toolName,
				requestedShape: shape,
				sessionId: args.sessionCorrelationId,
				agentActorId,
			}
			await recordMcpMisfire(args.db, args.workspaceId, misfire)
		}
	} catch (err) {
		logger.warn('mcp misfire emission failed', { error: String(err) })
	}
}

// Normalize both shapes the MCP SDK uses for error responses into a
// `{code, message}` object the classifier understands:
//   - Top-level JSON-RPC `error` (e.g. transport-level failures).
//   - `result.isError: true` with `content[0].text = "MCP error -32602: ..."`,
//     which is how `tools/call` returns bad-input / tool-not-found errors
//     on `@modelcontextprotocol/sdk` >= 1.29.
function extractError(message: JsonRpcMessage): JsonRpcErrorLike | undefined {
	if (message.error) return message.error
	const result = message.result
	if (!result || result.isError !== true) return undefined
	const text = result.content?.[0]?.text
	if (typeof text !== 'string' || text.length === 0) return undefined
	const codeMatch = text.match(/-3\d{4}\b/)
	const code = codeMatch ? Number(codeMatch[0]) : undefined
	return { code, message: text }
}

// The MCP SDK writes JSON responses either as a plain JSON body (with
// `enableJsonResponse: true`) or as SSE `event: message\ndata: {...}` frames
// when it needs to stream. Parse both defensively — anything we can't parse
// is silently dropped so a transport quirk can't spam warnings.
function parseJsonRpcResponses(bytes: Buffer): JsonRpcMessage[] {
	if (bytes.length === 0) return []
	const text = bytes.toString('utf8').trim()
	if (text.length === 0) return []

	const asJson = tryParseJson(text)
	if (asJson) return Array.isArray(asJson) ? asJson : [asJson]

	const messages: JsonRpcMessage[] = []
	for (const line of text.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed.startsWith('data:')) continue
		const payload = trimmed.slice('data:'.length).trim()
		if (!payload) continue
		const parsed = tryParseJson(payload)
		if (!parsed) continue
		if (Array.isArray(parsed)) messages.push(...parsed)
		else messages.push(parsed)
	}
	return messages
}

function tryParseJson(text: string): JsonRpcMessage | JsonRpcMessage[] | null {
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

function indexRequestsById(body: unknown): Map<string, JsonRpcMessage> {
	const out = new Map<string, JsonRpcMessage>()
	const list: JsonRpcMessage[] = Array.isArray(body)
		? (body as JsonRpcMessage[])
		: body && typeof body === 'object'
			? [body as JsonRpcMessage]
			: []
	for (const req of list) {
		if (req.id == null) continue
		out.set(String(req.id), req)
	}
	return out
}

// Extract the tool name for a misfire. Prefer the request's `params.name`; if
// the request pairing failed (e.g. batched response reordering) we fall back
// to parsing the tool name out of the error message text, since the SDK
// includes it in "Tool <name> not found" / "Invalid arguments for tool <name>".
function extractToolName(
	request: JsonRpcMessage | undefined,
	errorMessage: string | undefined,
): string | null {
	const fromRequest = request?.params?.name
	if (typeof fromRequest === 'string' && fromRequest.length > 0) return fromRequest
	if (!errorMessage) return null
	const match =
		errorMessage.match(
			/tool\s+([A-Za-z0-9_.-]+)\s+(?:not\s+found|not\s+registered|is\s+unknown)/i,
		) ??
		errorMessage.match(/invalid\s+arguments\s+for\s+tool\s+([A-Za-z0-9_.-]+)/i) ??
		errorMessage.match(/unknown\s+tool:?\s+([A-Za-z0-9_.-]+)/i)
	return match?.[1] ?? null
}

async function resolveAgentActorId(db: Database, apiKey: string): Promise<string | null> {
	try {
		const actor = await validateApiKey(db, apiKey)
		return actor?.actorId ?? null
	} catch (err) {
		logger.warn('mcp misfire actor lookup failed', { error: String(err) })
		return null
	}
}
