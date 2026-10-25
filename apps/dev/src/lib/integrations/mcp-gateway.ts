import { type AgentAccess, canRead, canWrite } from './agent-access'
import { accessDeniedMessage, allows, unavailableNote } from './tool-gate'
import {
	type ToolAnnotationsLike,
	type ToolKind,
	classifyCall,
	classifyTool,
	isCommandGated,
} from './tool-kinds'

/**
 * Pure parts of the MCP gateway (routes/integrations-gateway.ts): which providers go
 * through it, how a launch rewrites their MCP entries, and how a JSON-RPC message is
 * judged. No I/O here, so every rule is unit-tested without a server.
 *
 * Why a gateway at all: a hosted MCP (Linear, Gmail, ...) is a third party's server that
 * only knows a bearer token. To refuse writes for a read-only agent, Maskin has to see the
 * call, and for that the agent must never hold the token. So the token stays here, the
 * agent talks to Maskin with its own API key, and Maskin forwards what it allows.
 */

/**
 * Providers served through the gateway: a hosted HTTP MCP, authenticated by a token
 * Maskin already holds. Explicit, not derived: adding a provider here changes what a
 * container receives (no token env var), which is a decision, not a side effect.
 *
 * Resend and Ubersuggest are here because a grant now attaches their MCP server to an agent
 * by itself: with the token in the container, "read" could not stop Resend sending email.
 *
 * Not here, on purpose:
 *  - slack, linkedin-unipile, google-meet, google-search-console: Maskin hosts the MCP,
 *    gated in-process.
 *  - github: a stdio server in the container that also needs the token for git itself.
 */
export const GATEWAY_PROVIDERS: ReadonlySet<string> = new Set([
	'gmail',
	'google-calendar',
	'linear',
	'posthog',
	'resend',
	'ubersuggest',
])

export const GATEWAY_BODY_LIMIT_BYTES = 1_000_000

export function gatewayPath(provider: string): string {
	return `/api/integrations/${provider}/gateway`
}

/** The MCP server entry an agent uses to reach a provider through Maskin. */
export function gatewayServerSpec(provider: string): Record<string, unknown> {
	return {
		type: 'http',
		url: `\${MASKIN_API_URL}${gatewayPath(provider)}`,
		headers: {
			Authorization: 'Bearer ${MASKIN_API_KEY}',
			'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
		},
	}
}

function normalizeUrl(url: string): string {
	return url.trim().replace(/\/+$/, '')
}

/**
 * Points every entry that targets a gateway provider's upstream URL at the gateway
 * instead. Matched on the URL, not the key: the key is user-editable, while the URL is
 * what decides where a call goes (same reasoning as mcp-detach.ts). An entry that does
 * not target an upstream is returned untouched.
 */
export function rewriteMcpServersForGateway(
	servers: Record<string, unknown> | undefined,
	upstreamByProvider: ReadonlyMap<string, string>,
): { servers: Record<string, unknown> | undefined; rewritten: string[] } {
	if (!servers || typeof servers !== 'object') return { servers, rewritten: [] }
	const byUrl = new Map<string, string>()
	for (const [provider, url] of upstreamByProvider) byUrl.set(normalizeUrl(url), provider)
	const out: Record<string, unknown> = {}
	const rewritten: string[] = []
	for (const [key, entry] of Object.entries(servers)) {
		const url = (entry as { url?: unknown } | null)?.url
		const provider = typeof url === 'string' ? byUrl.get(normalizeUrl(url)) : undefined
		if (provider) {
			out[key] = gatewayServerSpec(provider)
			rewritten.push(key)
		} else {
			out[key] = entry
		}
	}
	return { servers: out, rewritten }
}

// ── JSON-RPC ─────────────────────────────────────────────────────────────

export type JsonRpcId = string | number | null

export interface JsonRpcMessage {
	jsonrpc?: string
	id?: JsonRpcId
	method?: string
	params?: Record<string, unknown>
}

export function parseJsonRpc(
	text: string,
): { ok: true; message: JsonRpcMessage } | { ok: false; reason: 'invalid' | 'batch' } {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return { ok: false, reason: 'invalid' }
	}
	if (Array.isArray(parsed)) return { ok: false, reason: 'batch' }
	if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'invalid' }
	return { ok: true, message: parsed as JsonRpcMessage }
}

export function toolsCallName(message: JsonRpcMessage): string | null {
	if (message.method !== 'tools/call') return null
	const name = message.params?.name
	return typeof name === 'string' && name.length > 0 ? name : null
}

/** A refusal shaped like a failed tool result, so the agent reads it as the tool's own answer. */
export function denialResult(id: JsonRpcId | undefined, text: string) {
	return {
		jsonrpc: '2.0' as const,
		id: id ?? null,
		result: { isError: true, content: [{ type: 'text' as const, text }] },
	}
}

export interface GatewayDecision {
	allowed: boolean
	kind: ToolKind
	/** For PostHog exec: the inner tool of a call, so a refusal and its event can name it. */
	innerTool?: string
	message?: string
}

const COMMAND_GATED_HINT =
	'Read access runs one query or lookup command per call; create, update and delete commands, chained commands and --confirm are refused.'
const COMMAND_GATED_LIST_NOTE =
	'Read access: query and lookup commands run; create, update and delete commands are refused.'

export function decideToolCall(input: {
	provider: string
	providerLabel: string
	toolName: string
	/** The tools/call arguments. Only read for a tool whose verdict depends on them. */
	args?: unknown
	access: AgentAccess
	annotations?: ToolAnnotationsLike | null
}): GatewayDecision {
	const { kind, innerTool } = classifyCall(
		input.provider,
		input.toolName,
		input.args,
		input.annotations,
	)
	if (allows(input.access, kind)) return { allowed: true, kind, innerTool }
	const named = innerTool ? `${input.toolName} (${innerTool})` : input.toolName
	const message = accessDeniedMessage({
		providerLabel: input.providerLabel,
		toolName: named,
		kind,
		access: input.access,
	})
	return {
		allowed: false,
		kind,
		innerTool,
		message: isCommandGated(input.provider, input.toolName)
			? `${message} ${COMMAND_GATED_HINT}`
			: message,
	}
}

// ── tools/list ───────────────────────────────────────────────────────────

interface ListedTool {
	name: string
	description?: string
	annotations?: ToolAnnotationsLike & Record<string, unknown>
	[k: string]: unknown
}

/**
 * A tool whose verdict depends on the call (PostHog exec). It lists as usable to anyone who
 * can read, since some of its commands are reads; readOnlyHint stays false because it can
 * write; a read-only agent is told which commands run. No access still shows it unavailable.
 */
function annotateCommandGatedTool(
	tool: ListedTool,
	ctx: { providerLabel: string; access: AgentAccess },
): ListedTool {
	const description = tool.description ?? ''
	const annotations = { ...tool.annotations, readOnlyHint: false }
	let note = ''
	if (!canRead(ctx.access)) note = unavailableNote(ctx.providerLabel, 'write', ctx.access)
	else if (!canWrite(ctx.access)) note = COMMAND_GATED_LIST_NOTE
	return {
		...tool,
		annotations,
		description: canRead(ctx.access)
			? `${description} ${note}`.trim()
			: `${note} ${description}`.trim(),
	}
}

/**
 * Rewrites an upstream tools/list result for this agent: every tool carries our
 * read/write verdict as readOnlyHint, and one it cannot use says so in its description.
 * Returns the annotations the server itself sent, to classify later calls with.
 */
export function annotateToolsList(
	result: { tools?: ListedTool[] } & Record<string, unknown>,
	ctx: { provider: string; providerLabel: string; access: AgentAccess },
): { result: Record<string, unknown>; upstreamAnnotations: Map<string, ToolAnnotationsLike> } {
	const upstreamAnnotations = new Map<string, ToolAnnotationsLike>()
	const tools = (result.tools ?? []).map((tool) => {
		if (tool.annotations) upstreamAnnotations.set(tool.name, tool.annotations)
		if (isCommandGated(ctx.provider, tool.name)) return annotateCommandGatedTool(tool, ctx)
		const kind = classifyTool(ctx.provider, tool.name, tool.annotations)
		const usable = kind === 'read' ? canRead(ctx.access) : canWrite(ctx.access)
		const description = tool.description ?? ''
		return {
			...tool,
			annotations: { ...tool.annotations, readOnlyHint: kind === 'read' },
			description: usable
				? description
				: `${unavailableNote(ctx.providerLabel, kind, ctx.access)} ${description}`.trim(),
		}
	})
	return { result: { ...result, tools }, upstreamAnnotations }
}

// ── SSE ──────────────────────────────────────────────────────────────────

/** Pulls the JSON payloads out of a complete text/event-stream body. */
export function parseSseData(body: string): unknown[] {
	const out: unknown[] = []
	for (const event of body.split(/\r?\n\r?\n/)) {
		const data = event
			.split(/\r?\n/)
			.filter((l) => l.startsWith('data:'))
			.map((l) => l.slice(5).replace(/^ /, ''))
			.join('\n')
		if (!data) continue
		try {
			out.push(JSON.parse(data))
		} catch {
			// A non-JSON event (a keep-alive comment) is not ours to rewrite.
		}
	}
	return out
}

export function toSse(messages: unknown[]): string {
	return messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join('')
}

// ── upstream auth ────────────────────────────────────────────────────────

/** Fills a provider's header templates (`Bearer ${LINEAR_TOKEN}`) with the real token. */
export function buildUpstreamHeaders(
	template: Record<string, string> | undefined,
	envKey: string,
	token: string,
): Record<string, string> {
	const headers: Record<string, string> = {}
	for (const [name, value] of Object.entries(template ?? {})) {
		const filled = value.split(`\${${envKey}}`).join(token)
		// A template still holding a placeholder we cannot fill is dropped, not sent as text.
		if (!/\$\{[^}]*\}/.test(filled)) headers[name] = filled
	}
	return headers
}
