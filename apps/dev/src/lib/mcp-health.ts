/**
 * Detects MCP servers that never came up, from the agent runtime's own
 * stream-json `init` envelope.
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
 * this session" survived a browser sidecar that had started and attached
 * correctly (session 317335d0, 2026-08-26).
 *
 * Emitting a `system` log line at ingest puts the failure where both the user
 * and the agent can see it, using the same seam as the github log classifier.
 */

/** Statuses that mean the server is usable. Anything else is a problem. */
const HEALTHY_STATUS = 'connected'

export interface UnhealthyMcpServer {
	name: string
	status: string
}

/**
 * Parse one stream-json line. Returns the servers that are not connected, or
 * null when the line is not an init envelope (the overwhelmingly common case,
 * so the cheap string check comes first) or when every server is healthy.
 */
export function detectUnhealthyMcpServers(line: string): UnhealthyMcpServer[] | null {
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

	const unhealthy: UnhealthyMcpServer[] = []
	for (const entry of envelope.mcp_servers) {
		if (!entry || typeof entry !== 'object') continue
		const { name, status } = entry as { name?: unknown; status?: unknown }
		if (typeof name !== 'string' || typeof status !== 'string') continue
		if (status !== HEALTHY_STATUS) unhealthy.push({ name, status })
	}
	return unhealthy.length > 0 ? unhealthy : null
}

/**
 * The user- and agent-facing line. Named servers first so the message is
 * useful at a glance in a log tail, and explicit that the tools are missing —
 * the failure mode is an absence, which is otherwise invisible.
 */
export function formatUnhealthyMcpWarning(servers: UnhealthyMcpServer[]): string {
	const detail = servers.map((s) => `${s.name} (${s.status})`).join(', ')
	const plural = servers.length === 1 ? 'server' : 'servers'
	return `MCP ${plural} did not connect: ${detail}. Their tools are unavailable in this session — an agent relying on them cannot use them, even if the underlying service is running.`
}
