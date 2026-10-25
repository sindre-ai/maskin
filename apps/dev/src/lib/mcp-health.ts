/**
 * Reports MCP servers that are not up, from the agent runtime's own
 * stream-json `init` envelope, and corrects the report when they come up.
 *
 * Why here: the CLI inside the sandbox reports the status of every configured
 * MCP server exactly once, in its init line:
 *
 *   {"type":"system","subtype":"init","mcp_servers":[
 *     {"name":"maskin","status":"connected"},
 *     {"name":"playwright","status":"pending"}, ...]}
 *
 * Nothing consumed that. A server stuck at "pending" or "failed" simply has no
 * tools, and the agent — which cannot see this line — concludes the capability
 * was never wired and says so to the user, while every log and metric around
 * it looks healthy. That is exactly how a customer-reported "no Playwright in
 * this session" survived a browser that had started and attached
 * correctly (session 317335d0, 2026-08-26).
 *
 * Emitting a `system` log line at ingest puts the failure where both the user
 * and the agent can see it, using the same seam as the github log classifier.
 */

/**
 * What the agent runtime calls a server (the init envelope's status string)
 * versus what this report says about it. Do not conflate the two: the envelope
 * is the runtime's vocabulary, the report state is ours.
 */
export type McpReportState = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'slow-unknown'

export interface McpInitServer {
	name: string
	status: string
}

export interface McpServerHealth {
	state: McpReportState
	/** Last envelope status seen for the server. */
	rawStatus: string
	resolvedAt: 'init' | 'resample' | 'cap'
}

/** Per-session record of what has been said about each non-healthy server. */
export type McpServerHealthMap = Map<string, McpServerHealth>

/**
 * Envelope status to report state. `disabled` is a deliberate config, not a
 * fault, so it maps to null and is never reported. A status string we do not
 * recognise is treated as pending: it is not a confirmed failure, and the cap
 * resolves it to slow-unknown if nothing else does.
 */
function classifyStatus(status: string): McpReportState | null {
	switch (status) {
		case 'connected':
			return 'connected'
		case 'failed':
			return 'failed'
		case 'needs-auth':
			return 'needs-auth'
		case 'disabled':
			return null
		default:
			return 'pending'
	}
}

/**
 * Parse one stream-json line. Returns every server in the init envelope, or
 * null when the line is not an init envelope (the overwhelmingly common case,
 * so the cheap string check comes first).
 */
export function parseMcpInit(line: string): McpInitServer[] | null {
	if (!line.includes('"subtype":"init"') || !line.includes('mcp_servers')) return null

	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== 'object') return null
	const envelope = parsed as { type?: unknown; subtype?: unknown; mcp_servers?: unknown }
	if (envelope.type !== 'system' || envelope.subtype !== 'init') return null
	if (!Array.isArray(envelope.mcp_servers)) return null

	const servers: McpInitServer[] = []
	for (const entry of envelope.mcp_servers) {
		if (!entry || typeof entry !== 'object') continue
		const { name, status } = entry as { name?: unknown; status?: unknown }
		if (typeof name !== 'string' || typeof status !== 'string') continue
		servers.push({ name, status })
	}
	return servers
}

/**
 * Names, out of `candidates`, that this line proves are up: a tool_use or
 * tool_result block named mcp__[server]__[tool]. The model can only call a
 * tool the runtime has loaded, so such a block means the server connected
 * after the init envelope was written.
 */
export function detectMcpToolUse(line: string, candidates: string[]): string[] {
	if (candidates.length === 0 || !line.includes('mcp__')) return []

	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch {
		return []
	}
	const content = (parsed as { message?: { content?: unknown } } | null)?.message?.content
	if (!Array.isArray(content)) return []

	const hits = new Set<string>()
	for (const block of content) {
		if (!block || typeof block !== 'object') continue
		const { type, name } = block as { type?: unknown; name?: unknown }
		if ((type !== 'tool_use' && type !== 'tool_result') || typeof name !== 'string') continue
		for (const candidate of candidates) {
			if (name.startsWith(`mcp__${candidate}__`)) hits.add(candidate)
		}
	}
	return [...hits]
}

/** True while at least one server could still change state. */
export function hasPendingMcpServers(servers: McpServerHealthMap): boolean {
	for (const health of servers.values()) if (health.state === 'pending') return true
	return false
}

/**
 * The user- and agent-facing lines. "Did not connect" is reserved for failed
 * servers; pending and slow-unknown copy says outright that this is not a
 * failure, so an agent does not route around a tool it may actually have.
 */
export function formatMcpHealthLine(state: McpReportState, name: string): string {
	switch (state) {
		case 'failed':
			return `MCP server did not connect: ${name}. It failed to start, so its tools are unavailable in this session.`
		case 'needs-auth':
			return `MCP server needs authentication: ${name}. Its tools are unavailable until you authenticate it.`
		case 'pending':
			return `MCP server still starting: ${name}. It is not connected yet; this is not a failure, we will report again if it connects.`
		case 'slow-unknown':
			return `MCP server did not finish starting within the observation window: ${name}. Status unknown, it may still be starting; this is not a confirmed failure.`
		case 'connected':
			return `MCP server connected after starting: ${name}. Its tools are now available.`
	}
}

/**
 * First sight of the init envelope. Records every server that is neither
 * connected nor disabled and returns the lines to log, in envelope order.
 * Healthy servers are not recorded and never reported.
 */
export function registerMcpInit(servers: McpServerHealthMap, init: McpInitServer[]): string[] {
	const lines: string[] = []
	for (const { name, status } of init) {
		const state = classifyStatus(status)
		if (state === null || state === 'connected') continue
		servers.set(name, { state, rawStatus: status, resolvedAt: 'init' })
		lines.push(formatMcpHealthLine(state, name))
	}
	return lines
}

/**
 * A later envelope carrying mcp_servers (forward-compat: the runtime emits
 * init once today). Only a server still pending may move; connected,
 * failed, needs-auth and slow-unknown are terminal, so a replayed init line
 * can never downgrade or re-open anything.
 */
export function applyMcpEnvelope(servers: McpServerHealthMap, envelope: McpInitServer[]): string[] {
	const lines: string[] = []
	for (const { name, status } of envelope) {
		const prev = servers.get(name)
		if (prev?.state !== 'pending') continue
		const next = classifyStatus(status)
		if (next === null || next === 'pending') continue
		servers.set(name, { state: next, rawStatus: status, resolvedAt: 'resample' })
		lines.push(formatMcpHealthLine(next, name))
	}
	return lines
}

/** Tool-use evidence: a pending server that shows up in use is connected. */
export function applyMcpToolUse(servers: McpServerHealthMap, line: string): string[] {
	const pending: string[] = []
	for (const [name, health] of servers) if (health.state === 'pending') pending.push(name)

	const lines: string[] = []
	for (const name of detectMcpToolUse(line, pending)) {
		const prev = servers.get(name)
		if (!prev) continue
		servers.set(name, { state: 'connected', rawStatus: prev.rawStatus, resolvedAt: 'resample' })
		lines.push(formatMcpHealthLine('connected', name))
	}
	return lines
}

/** The cap fired: whatever is still pending becomes slow-unknown, never failed. */
export function expireMcpPending(servers: McpServerHealthMap): string[] {
	const lines: string[] = []
	for (const [name, health] of servers) {
		if (health.state !== 'pending') continue
		servers.set(name, { state: 'slow-unknown', rawStatus: health.rawStatus, resolvedAt: 'cap' })
		lines.push(formatMcpHealthLine('slow-unknown', name))
	}
	return lines
}
