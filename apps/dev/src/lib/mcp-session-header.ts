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

// Second header stamped when the session was dispatched from a comment: the
// events.id of the triggering comment (or its thread root). Consumed by
// packages/mcp's `create_comment` handler to default `parent_event_id` to the
// triggering thread — the tool-level guarantee that agents reply in-thread
// even when their system prompt doesn't remember to. Only stamped when
// session-manager.ts knows the id (i.e. the session config carries
// `source_comment_event_id`), so the value substituted for the placeholder
// is always a real integer rather than an unset env expanding to empty.
export const MASKIN_TRIGGERING_EVENT_HEADER = 'X-Maskin-Triggering-Event-Id'
export const MASKIN_TRIGGERING_EVENT_HEADER_VALUE = '${MASKIN_TRIGGERING_EVENT_ID}'

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
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMaskinMcpEntry(entry: unknown): entry is Record<string, unknown> {
	if (!isPlainObject(entry)) return false
	const e = entry as Record<string, unknown>
	if (e.type !== undefined && e.type !== 'http') return false
	const url = typeof e.url === 'string' ? e.url.trim() : ''
	// Must be the platform MCP endpoint *exactly*. A suffix test on '/mcp' is
	// not enough: the Slack integration server lives at
	// `${MASKIN_API_URL}/api/integrations/slack/mcp` on the same host and would
	// match one, but it is a different server with no session to attribute.
	return /^\$\{MASKIN_API_URL\}\/mcp\/?$/.test(url)
}

export interface StampMaskinSessionHeaderOptions {
	/**
	 * When true, also stamp `X-Maskin-Triggering-Event-Id: ${MASKIN_TRIGGERING_EVENT_ID}`
	 * onto every Maskin MCP entry. Callers pass this iff they also inject the
	 * matching container env var; otherwise the header would substitute to
	 * empty and the /mcp route would ignore it.
	 */
	includeTriggeringEventId?: boolean
}

/**
 * Returns a copy of `mcpServers` with the session header added to every Maskin
 * MCP entry. Non-Maskin entries are passed through untouched, and an entry that
 * already carries the header is left alone so an explicit override wins.
 *
 * When `options.includeTriggeringEventId` is true, the triggering-event header
 * is stamped alongside the session header — used to default `create_comment`
 * back into the triggering thread on the /mcp route.
 *
 * Returns `null` unchanged so callers can keep distinguishing "no agent-level
 * MCP config" from "an empty one".
 */
export function stampMaskinSessionHeader<T extends Record<string, unknown> | null | undefined>(
	mcpServers: T,
	options: StampMaskinSessionHeaderOptions = {},
): T {
	if (!mcpServers || typeof mcpServers !== 'object') return mcpServers
	const includeTriggering = options.includeTriggeringEventId === true
	let changed = false
	const out: Record<string, unknown> = {}
	for (const [name, entry] of Object.entries(mcpServers)) {
		if (!isMaskinMcpEntry(entry)) {
			out[name] = entry
			continue
		}
		// `headers` comes off the same workspace-editable, unschema'd `tools`
		// blob as the rest of the entry, so it is not necessarily an object. A
		// non-object here used to reach the `in` operator below, which throws a
		// TypeError — synchronously, inside `launchContainer`, failing the whole
		// session launch over an analytics-only stamping step. Pass such an entry
		// through untouched instead: its tool calls fall back to
		// `session_source: 'unknown'`, the same graceful degradation any other
		// unstampable entry already gets.
		const rawHeaders = entry.headers
		if (rawHeaders !== undefined && !isPlainObject(rawHeaders)) {
			out[name] = entry
			continue
		}
		const headers = (rawHeaders ?? {}) as Record<string, unknown>
		const hasSession = MASKIN_SESSION_HEADER in headers
		const hasTriggering = MASKIN_TRIGGERING_EVENT_HEADER in headers
		const needsSession = !hasSession
		const needsTriggering = includeTriggering && !hasTriggering
		if (!needsSession && !needsTriggering) {
			out[name] = entry
			continue
		}
		const nextHeaders: Record<string, unknown> = { ...headers }
		if (needsSession) {
			nextHeaders[MASKIN_SESSION_HEADER] = MASKIN_SESSION_HEADER_VALUE
		}
		if (needsTriggering) {
			nextHeaders[MASKIN_TRIGGERING_EVENT_HEADER] = MASKIN_TRIGGERING_EVENT_HEADER_VALUE
		}
		out[name] = { ...entry, headers: nextHeaders }
		changed = true
	}
	return (changed ? out : mcpServers) as T
}
