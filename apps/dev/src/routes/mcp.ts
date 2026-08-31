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
import { type SeqCounter, createSeqCounter } from '../lib/mcp-trace-seq'

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
	// Resolved before the server is built so it can be threaded into telemetry:
	// the in-process MCP server would otherwise stamp its events with the app
	// PROCESS's id, shared by every caller of `/mcp`. An unidentified caller
	// passes nothing, leaving the process id in place — it groups nothing
	// either way, and inventing a per-request id would just mint one throwaway
	// session per POST.
	const session = resolveSessionIdentity(c.req.header.bind(c.req))
	const mcpConfig = {
		apiBaseUrl: `http://localhost:${Number(process.env.PORT) || 3000}`,
		apiKey,
		defaultWorkspaceId: workspaceId,
		transport: 'http' as const,
		webAppBaseUrl: resolveWebAppBaseUrl(process.env),
		telemetrySessionId: session.source === 'unknown' ? undefined : session.id,
		telemetrySessionSource:
			session.source === 'maskin-session' ? ('maskin-session' as const) : ('process' as const),
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
	const plannedCalls = planTracedCalls(body, session, startedAt, workspaceId)

	// `finally`, not a plain sequence: a throw out of `handleRequest` would
	// otherwise skip emission entirely, having ALREADY spent the sequence
	// numbers above. The gaps in `seq` would then correlate exactly with the
	// failures — missing precisely the rows this event exists to surface. On
	// that path there are no response bytes to pair, so every planned call is
	// recorded unpaired, which `emitMcpTrace` already buckets as `no-response`.
	try {
		await mcpServer.connect(transport)
		await transport.handleRequest(nodeReq, nodeRes, body)
	} finally {
		// Read the clock HERE, synchronously, for the same reason `seq` is
		// allocated synchronously above: `emitMcpTrace` awaits an actor lookup
		// that costs a DB roundtrip on a cache miss and nothing on a hit. Timing
		// the call from inside the emitter would fold that lookup into
		// `duration_ms`, giving every tool a bimodal latency distribution whose
		// second mode is our own cache behaviour rather than the tool's.
		const elapsedMs = Date.now() - startedAt

		// Fire-and-forget: emit one `mcp_tool_call` trace event per tools/call,
		// plus one PostHog event per real misfire. Both read the same captured
		// bytes. The `.catch` is not decoration: this is an un-awaited async
		// call, so an unhandled rejection here takes down the whole apps/dev
		// process. Analytics must never be able to do that.
		void emitMcpTrace({
			db: c.get('db'),
			apiKey,
			workspaceId,
			requestBody: body,
			responseBytes: captured.consume(),
			session,
			elapsedMs,
			plannedCalls,
		}).catch((err) => logger.warn('mcp trace emission failed', { error: String(err) }))
	}

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

// Longest session id we will group on. Matches `sessionIdSchema` in
// @maskin/shared, which already caps the stdio ingest path — this is the same
// boundary for the HTTP one. The value becomes a long-lived map key and a
// PostHog dimension, so it must be bounded at the edge.
const MAX_SESSION_ID_LEN = 128

// An env placeholder that reached us verbatim, e.g. `${SESSION_ID}`.
//
// The Maskin MCP preset carries `X-Maskin-Session-Id: ${SESSION_ID}`, expanded
// by agent-run.sh's envsubst pass. Any path that skips that pass — a user
// copying the preset out of the UI into their own `claude mcp add` — sends the
// literal text instead. Accepting it would merge every such client, across
// every workspace, into one bucket with interleaved seq numbers, labelled
// `maskin-session`: the tag that means "this is a real sessions.id". Wrong data
// wearing the highest-confidence label is worse than no data, so these fall
// through to `unknown`. agent-run.sh guards BROWSER_CDP_URL the same way.
const UNEXPANDED_PLACEHOLDER_RE = /^\$\{[^}]*\}$/

// `sessions.id` is a uuid. `X-Maskin-Session-Id` is the only header that earns
// the `maskin-session` label, whose entire contract is "this value IS a
// sessions.id and joins back to that row" — so it has to look like one.
//
// This is a shape check, not an authorization check, and cannot be more: the
// route is mounted outside `authMiddleware` and the trace is analytics, not an
// access decision. It buys the two things that matter here. A malformed or
// hand-edited value no longer wears the highest-confidence label — it falls
// through to `mcp-session`, which promises only grouping. And a caller can no
// longer aim an arbitrary string at another session's sequence counter by
// accident; a deliberate attacker who knows a real session uuid still can, so
// treat `maskin-session` rows as attributable-by-convention, not as attested.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function usableSessionId(raw: string | undefined): string | null {
	const value = raw?.trim()
	if (!value) return null
	if (value.length > MAX_SESSION_ID_LEN) return null
	if (UNEXPANDED_PLACEHOLDER_RE.test(value)) return null
	return value
}

export function resolveSessionIdentity(
	header: (name: string) => string | undefined,
): McpSessionIdentity {
	const maskinSessionId = usableSessionId(header('X-Maskin-Session-Id'))
	if (maskinSessionId && UUID_RE.test(maskinSessionId)) {
		return { id: maskinSessionId, source: 'maskin-session' }
	}
	// Present but not uuid-shaped: keep the value (it still groups a caller's
	// calls) and downgrade the label rather than dropping to `unknown`, which
	// would discard usable ordering over a claim we merely could not confirm.
	if (maskinSessionId) return { id: maskinSessionId, source: 'mcp-session' }
	const mcpSessionId = usableSessionId(header('Mcp-Session-Id'))
	if (mcpSessionId) return { id: mcpSessionId, source: 'mcp-session' }
	return {
		id: `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
		source: 'unknown',
	}
}

// ── Trace + misfire emission ────────────────────────────────────────────

// TWO counters, partitioned by how much the session id is trusted — not one.
//
// `POST /mcp` is mounted outside `authMiddleware`, and `source: 'mcp-session'`
// is reached by sending any `Mcp-Session-Id` header at all, with a
// client-supplied `X-Workspace-Id` also folded into the key. On a single shared
// counter an unauthenticated caller could therefore mint unlimited distinct
// keys, drive the map to its cap, and start evicting real agent sessions —
// which then silently restart at 1. That is precisely the ordering-collapse
// failure `lib/mcp-trace-seq.ts` is built to avoid, reached from outside.
//
// Splitting the map bounds the blast radius to the caller's own tier:
// unauthenticated traffic can only ever evict other unauthenticated traffic.
// `maskin-session` requires a uuid-shaped `X-Maskin-Session-Id`, which is not
// a strong guarantee (see `UUID_RE`) but is the strongest signal available on
// this route, and it is what agent-launched sessions carry.
const maskinSeqCounter = createSeqCounter()
const untrustedSeqCounter = createSeqCounter()

function counterFor(session: McpSessionIdentity): SeqCounter {
	return session.source === 'maskin-session' ? maskinSeqCounter : untrustedSeqCounter
}

// The counter is keyed on more than the session id, because the id alone is
// not unique. `Mcp-Session-Id` is chosen by the client and validated only for
// length, and `POST /mcp` is mounted outside `authMiddleware` — so two
// unrelated callers that both pick `1` would share one counter and each see a
// sequence with half its numbers missing, with no duplicates to reveal the
// collision. Including the source keeps a `mcp-session` id from ever landing
// on a `maskin-session` one; including the workspace confines a collision to
// callers who already share a workspace.
function seqKey(session: McpSessionIdentity, workspaceId: string): string {
	return `${session.source}:${workspaceId}:${session.id}`
}

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
	/** Null for a session we cannot order — see `planTracedCalls`. */
	seq: number | null
	tsMs: number
}

/**
 * Assign sequence numbers to the tool calls in a request body. Must be called
 * synchronously from the request handler — see the comment at its call site.
 *
 * Calls without a usable tool name are skipped rather than numbered, so a
 * number is only ever spent on a call this function actually plans to emit.
 * (Emission can still fail downstream, so a gap in the delivered events is
 * possible — `seq` orders what arrives, it does not prove nothing was lost.)
 *
 * An unidentified caller gets `seq: null` and never touches the counter. Its
 * id is freshly minted per request and never recurs, so a slot spent on it
 * could only ever hold the number 1 — while occupying that slot for the full
 * TTL. Since `POST /mcp` is mounted outside `authMiddleware`, unauthenticated
 * traffic alone could otherwise push the counter to its cap and start evicting
 * live sessions, which would then silently restart at 1: exactly the
 * ordering-collapse failure `lib/mcp-trace-seq.ts` is built to avoid.
 */
export function planTracedCalls(
	body: unknown,
	session: McpSessionIdentity,
	tsMs: number,
	workspaceId: string,
): PlannedTracedCall[] {
	const planned: PlannedTracedCall[] = []
	for (const request of listRequests(body)) {
		if (request.method !== 'tools/call') continue
		const toolName = request.params?.name
		if (typeof toolName !== 'string' || toolName.length === 0) continue
		const seq =
			session.source === 'unknown' ? null : counterFor(session).next(seqKey(session, workspaceId))
		planned.push({ request, toolName, seq, tsMs })
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
	/**
	 * Wall-clock duration of the POST, measured at the request handler rather
	 * than here — see the comment at the call site.
	 */
	elapsedMs: number
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
		// A batched POST shares BOTH its wall-clock measurement and its response
		// body between the calls it carries, so neither can be attributed to an
		// individual call. Recording them anyway would make a batch of N look
		// like N calls that each took the whole POST's time and each returned
		// the whole POST's bytes — inflating any sum or average by roughly N×,
		// silently, in the direction that makes tools look worse than they are.
		// Null instead: absent is honest, wrong is not.
		const isSingleCall = args.plannedCalls.length === 1
		const durationMs = isSingleCall ? args.elapsedMs : null
		const responseBytes = isSingleCall ? args.responseBytes.length : null

		await Promise.all(
			args.plannedCalls.map(({ request, toolName, seq, tsMs }) => {
				const response = request.id != null ? responsesById.get(String(request.id)) : undefined
				const error = response ? extractError(response) : undefined
				// A call we could not pair with a response did not succeed, and must
				// not be recorded as though it did. `ok: !error` alone reads a missing
				// response as "no error found" — so a transport-level rejection, a
				// malformed batch, or an id-less `tools/call` would land in analytics
				// as a success, in an event whose whole purpose is surfacing failures.
				// Bucketed separately from a classified error so the two stay
				// distinguishable: this is our own blind spot, not the tool's fault.
				const unpaired = !response
				return captureMcpToolCall(args.workspaceId, {
					sessionId: args.session.id,
					sessionSource: args.session.source,
					seq,
					tsMs,
					toolName,
					argKeys: argKeys(request.params?.arguments),
					ok: !unpaired && !error,
					errorClass: unpaired
						? 'no-response'
						: error
							? (classifyMcpError(error) ?? 'unclassified')
							: null,
					durationMs,
					responseBytes,
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
	// Filter to objects: `[null, {...}]` is valid JSON, and reading `.id` off
	// that null throws — inside an un-awaited emitter, that is an unhandled
	// rejection, i.e. a dead app process. Nothing we ship emits such a body;
	// this is here so a transport quirk cannot escalate into an outage.
	if (asJson) return (Array.isArray(asJson) ? asJson : [asJson]).filter(isJsonRpcMessage)

	const messages: JsonRpcMessage[] = []
	for (const line of text.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed.startsWith('data:')) continue
		const payload = trimmed.slice('data:'.length).trim()
		if (!payload) continue
		const parsed = tryParseJson(payload)
		if (!parsed) continue
		if (Array.isArray(parsed)) messages.push(...parsed.filter(isJsonRpcMessage))
		else if (isJsonRpcMessage(parsed)) messages.push(parsed)
	}
	return messages
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
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
	maskinSeqCounter.reset()
	untrustedSeqCounter.reset()
}

/**
 * Number of sessions the counter is tracking. Only used in tests, to assert
 * that an unidentified caller consumes no slot.
 */
export function __mcpTraceSeqSize(): number {
	return maskinSeqCounter.size() + untrustedSeqCounter.size()
}

/**
 * Sessions tracked per trust tier. Only used in tests, to assert that
 * unauthenticated callers land in their own map and so cannot evict
 * agent-launched sessions when they exhaust a cap.
 */
export function __mcpTraceSeqSizes(): { maskin: number; untrusted: number } {
	return { maskin: maskinSeqCounter.size(), untrusted: untrustedSeqCounter.size() }
}
