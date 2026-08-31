// Stamp the running session's id onto the Maskin MCP entries in an agent's MCP
// config, so tool calls made from inside a container can be attributed to the
// session that made them.
//
// The value is the literal `${SESSION_ID}` placeholder, not the id itself:
// agent-run.sh's setup_mcps() pipes the merged config through `envsubst`
// before writing /tmp/mcp-config.json, and SESSION_ID is already a reserved
// container env var holding the `sessions.id` uuid. Emitting the placeholder
// keeps this consistent with how ${MASKIN_API_KEY} and ${MASKIN_WORKSPACE_ID}
// already reach the container.

export const MASKIN_SESSION_HEADER = 'X-Maskin-Session-Id'
export const MASKIN_SESSION_HEADER_VALUE = '${SESSION_ID}'

/**
 * True for an MCP entry written with the platform preset's
 * `${MASKIN_API_URL}/mcp` placeholder — which every config this repo generates
 * uses. An entry holding an already-resolved absolute URL is deliberately NOT
 * matched: it is not stamped, and its tool calls fall through to
 * `session_source: 'unknown'` rather than being mislabelled. Matched on
 * the placeholders the preset uses rather than on the entry's key name, because
 * the same server is registered under several names (the agent's `tools` blob,
 * `session-mcp-N`, seeded presets) and a hardcoded name list would silently
 * miss one.
 */
function isMaskinMcpEntry(entry: unknown): entry is Record<string, unknown> {
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
	const e = entry as Record<string, unknown>
	if (e.type !== undefined && e.type !== 'http') return false
	const url = typeof e.url === 'string' ? e.url.trim() : ''
	// Must be the platform MCP endpoint *exactly*. A suffix test on '/mcp' is
	// not enough: the Slack integration server lives at
	// `${MASKIN_API_URL}/api/integrations/slack/mcp` on the same host and would
	// match one, but it is a different server with no session to attribute.
	return /^\$\{MASKIN_API_URL\}\/mcp\/?$/.test(url)
}

/**
 * Returns a copy of `mcpServers` with the session header added to every Maskin
 * MCP entry. Non-Maskin entries are passed through untouched, and an entry that
 * already carries the header is left alone so an explicit override wins.
 *
 * Returns `null` unchanged so callers can keep distinguishing "no agent-level
 * MCP config" from "an empty one".
 */
export function stampMaskinSessionHeader<T extends Record<string, unknown> | null | undefined>(
	mcpServers: T,
): T {
	if (!mcpServers || typeof mcpServers !== 'object') return mcpServers
	let changed = false
	const out: Record<string, unknown> = {}
	for (const [name, entry] of Object.entries(mcpServers)) {
		if (!isMaskinMcpEntry(entry)) {
			out[name] = entry
			continue
		}
		const headers = (entry.headers ?? {}) as Record<string, unknown>
		if (MASKIN_SESSION_HEADER in headers) {
			out[name] = entry
			continue
		}
		out[name] = {
			...entry,
			headers: { ...headers, [MASKIN_SESSION_HEADER]: MASKIN_SESSION_HEADER_VALUE },
		}
		changed = true
	}
	return (changed ? out : mcpServers) as T
}
