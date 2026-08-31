import { createHash } from 'node:crypto'
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
import { type McpSessionSource, argKeys, captureMcpToolCall } from '../lib/analytics/mcp-tool-calls'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { createSeqCounter } from '../lib/mcp-trace-seq'

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

	const startedAt = Date.now()

	// Allocate sequence numbers HERE — synchronously, before any await. `seq`
	// exists because these events are fire-and-forget and can be ingested out
	// of order, so it has to be stamped at the moment the call is observed. Do
	// it downstream (inside the emitter, past the awaited actor lookup) and two
	// calls on one session can invert: a cache-miss lookup takes a DB roundtrip
	// while a call arriving a millisecond later hits a warm cache and numbers
	// itself first. Agents issue tool calls in parallel routinely, so that is
	// an ordinary case, not a rare race.
	const session = resolveSessionIdentity(c.req.header.bind(c.req))
	const plannedCalls = planTracedCalls(body, session, startedAt)

	await mcpServer.connect(transport)
	await transport.handleRequest(nodeReq, nodeRes, body)

	// Fire-and-forget: emit one `mcp_tool_call` trace event per tools/call, plus
	// one PostHog event per real misfire. Both read the same captured bytes.
	void emitMcpTrace({
		db: c.get('db'),
		apiKey,
		workspaceId,
		requestBody: body,
		responseBytes: captured.consume(),
		session,
		startedAt,
		plannedCalls,
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

// ── Session identity ────────────────────────────────────────────────────
//
// The HTTP transport is stateless (`sessionIdGenerator: undefined` above), so
// the MCP SDK never mints a session id of its own. We resolve one from headers
// instead, most-specific first:
//
//   1. `X-Maskin-Session-Id` — stamped onto the Maskin MCP entry by
//      session-manager for agents running *inside* Maskin. It is the
//      `sessions.id` uuid, so a trace joins straight back to the session row.
//   2. `Mcp-Session-Id` — whatever an external client chose to send.
//   3. Neither — an external HTTP client we cannot group. We still emit the
//      event (the tool-usage signal is worth having) under a per-request id,
//      flagged `unknown` so it is trivially excluded from ordering queries.

export interface McpSessionIdentity {
	id: string
	source: McpSessionSource
}

export function resolveSessionIdentity(
	header: (name: string) => string | undefined,
): McpSessionIdentity {
	const maskinSessionId = header('X-Maskin-Session-Id')?.trim()
	if (maskinSessionId) return { id: maskinSessionId, source: 'maskin-session' }
	const mcpSessionId = header('Mcp-Session-Id')?.trim()
	if (mcpSessionId) return { id: mcpSessionId, source: 'mcp-session' }
	return {
		id: `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
		source: 'unknown',
	}
}

// ── Trace + misfire emission ────────────────────────────────────────────

const seqCounter = createSeqCounter()

// Resolving the actor means a DB lookup per API key. Tool calls arrive in
// bursts from the same agent, so memoize the mapping for a short window rather
// than hitting `validateApiKey` on every single call. Short TTL because a
// revoked key should stop being attributed reasonably promptly — this is an
// analytics label, not an authorization decision, so staleness here is cheap.
const ACTOR_CACHE_TTL_MS = 60_000

// Hard cap. `POST /mcp` is mounted OUTSIDE `authMiddleware` (see app-factory:
// auth covers `/api/*`, this route is mounted at `/mcp`), so this cache is fed
// by unauthenticated input: any caller can present an arbitrary bearer token
// and reach the lookup below. An unbounded map would therefore grow without
// limit on request volume alone. Bounded + swept, same discipline as
// `lib/mcp-trace-seq.ts`.
const ACTOR_CACHE_MAX = 5_000

// Keyed by a SHA-256 of the API key, never the key itself: this map outlives
// the 60s TTL of any individual entry, and plaintext credentials sitting in a
// long-lived process map end up in every heap dump.
const actorCache = new Map<string, { actorId: string | null; at: number }>()

function actorCacheKey(apiKey: string): string {
	return createHash('sha256').update(apiKey).digest('hex')
}

/**
 * Negative results ARE cached. That is deliberate: an invalid key is exactly
 * what an abusive caller sends, and not caching it would turn every such
 * request into a `validateApiKey` query — trading bounded memory for unbounded
 * DB load. The cap below is what keeps the memory side honest.
 */
function rememberActor(key: string, actorId: string | null, at: number): void {
	if (!actorCache.has(key) && actorCache.size >= ACTOR_CACHE_MAX) {
		for (const [k, v] of actorCache) {
			if (at - v.at >= ACTOR_CACHE_TTL_MS) actorCache.delete(k)
		}
		// Still full of live entries — evict oldest-inserted first.
		while (actorCache.size >= ACTOR_CACHE_MAX) {
			const oldest = actorCache.keys().next()
			if (oldest.done) break
			actorCache.delete(oldest.value)
		}
	}
	actorCache.set(key, { actorId, at })
}

/**
 * One tools/call, with its ordering already fixed. Built synchronously on the
 * request path so `seq`/`tsMs` reflect observation order rather than however
 * long the emitter's async work took.
 */
interface PlannedTracedCall {
	request: JsonRpcMessage
	toolName: string
	seq: number
	tsMs: number
}

/**
 * Assign sequence numbers to the tool calls in a request body. Must be called
 * synchronously from the request handler — see the comment at its call site.
 *
 * Calls without a usable tool name are skipped rather than numbered, so `seq`
 * stays gapless over the events actually emitted.
 */
export function planTracedCalls(
	body: unknown,
	session: McpSessionIdentity,
	tsMs: number,
): PlannedTracedCall[] {
	const planned: PlannedTracedCall[] = []
	for (const request of listRequests(body)) {
		if (request.method !== 'tools/call') continue
		const toolName = request.params?.name
		if (typeof toolName !== 'string' || toolName.length === 0) continue
		planned.push({ request, toolName, seq: seqCounter.next(session.id), tsMs })
	}
	return planned
}

interface EmitMcpTraceArgs {
	db: Database | undefined
	apiKey: string
	workspaceId: string
	requestBody: unknown
	responseBytes: Buffer
	session: McpSessionIdentity
	startedAt: number
	plannedCalls: PlannedTracedCall[]
}

async function emitMcpTrace(args: EmitMcpTraceArgs): Promise<void> {
	let responses: JsonRpcMessage[]
	let agentActorId: string | null = null
	try {
		responses = parseJsonRpcResponses(args.responseBytes)
		if (args.plannedCalls.length === 0 && responses.length === 0) return
		agentActorId = args.apiKey && args.db ? await resolveAgentActorId(args.db, args.apiKey) : null
	} catch (err) {
		logger.warn('mcp trace response parse failed', { error: String(err) })
		return
	}

	const responsesById = new Map<string, JsonRpcMessage>()
	for (const r of responses) {
		if (r.id != null) responsesById.set(String(r.id), r)
	}

	// The two phases below are independent and must stay that way: misfire
	// recording is a separate, pre-existing metric that predates tracing, and a
	// failure in the new trace path must not be able to suppress it. Hence two
	// try blocks rather than one wrapping both — and a distinct log message per
	// phase, so a warn line identifies which half actually died.

	// ── Trace: one event per tools/call, success or failure ──
	try {
		// A batched POST shares one wall-clock measurement between its calls, so
		// only attribute a duration when the batch held exactly one tool call.
		const elapsedMs = Date.now() - args.startedAt
		const durationMs = args.plannedCalls.length === 1 ? elapsedMs : null

		await Promise.all(
			args.plannedCalls.map(({ request, toolName, seq, tsMs }) => {
				const response = request.id != null ? responsesById.get(String(request.id)) : undefined
				const error = response ? extractError(response) : undefined
				return captureMcpToolCall(args.workspaceId, {
					sessionId: args.session.id,
					sessionSource: args.session.source,
					seq,
					tsMs,
					toolName,
					argKeys: argKeys(request.params?.arguments),
					ok: !error,
					errorClass: error ? (classifyMcpError(error) ?? 'unclassified') : null,
					durationMs,
					responseBytes: args.responseBytes.length,
					transport: 'http',
					agentActorId,
				})
			}),
		)
	} catch (err) {
		logger.warn('mcp trace capture failed', { error: String(err) })
	}

	// ── Misfires: unchanged behaviour, one row + event per classified error ──
	try {
		const errored = responses
			.map((r) => ({ message: r, error: extractError(r) }))
			.filter((r): r is { message: JsonRpcMessage; error: JsonRpcErrorLike } => Boolean(r.error))
		if (errored.length === 0) return

		const requestsById = indexRequestsById(args.requestBody)
		const misfireSessionId = args.session.source === 'unknown' ? null : args.session.id
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
				sessionId: misfireSessionId,
				agentActorId,
			}
			await recordMcpMisfire(args.db, args.workspaceId, misfire)
		}
	} catch (err) {
		logger.warn('mcp misfire emission failed', { error: String(err) })
	}
}

/** Flatten a request body (single message or JSON-RPC batch) into a list. */
function listRequests(body: unknown): JsonRpcMessage[] {
	if (Array.isArray(body)) return body as JsonRpcMessage[]
	if (body && typeof body === 'object') return [body as JsonRpcMessage]
	return []
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
	const key = actorCacheKey(apiKey)
	const cached = actorCache.get(key)
	if (cached && Date.now() - cached.at < ACTOR_CACHE_TTL_MS) return cached.actorId
	try {
		const actor = await validateApiKey(db, apiKey)
		const actorId = actor?.actorId ?? null
		rememberActor(key, actorId, Date.now())
		return actorId
	} catch (err) {
		logger.warn('mcp trace actor lookup failed', { error: String(err) })
		return null
	}
}

/** Clears the memoized API-key → actor mapping. Only used in tests. */
export function __resetMcpActorCache(): void {
	actorCache.clear()
}

/**
 * Resets the per-session sequence numbers. Only used in tests — the counter is
 * module-level (one process, one counter), so without this each test case
 * inherits the numbering left behind by the previous one.
 */
export function __resetMcpTraceSeq(): void {
	seqCounter.reset()
}
