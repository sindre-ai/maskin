import type { JsonRpcErrorLike } from './mcp-misfire'

// A bucket for a failed tools/call that `classifyMcpError` does not name. That function only
// knows the three protocol-level misfires (unknown tool, unknown parameter, schema validation).
// Every other failure used to land in the tool_call event as 'unclassified': in a 30-day PostHog
// sample that was 405 of the update_objects failures and half of the send_session_message ones,
// which turned out to be a refused empty write and a 403 for a session another actor started.
//
// The buckets are read from the error text the tool returned. They are coarse on purpose: a stable
// set a dashboard can group on, not a taxonomy. Anything that still matches nothing stays
// 'unclassified', so that bucket keeps meaning "look at this".
export const MCP_TOOL_ERROR_CLASSES = [
	'permission_denied',
	'not_found',
	'rate_limited',
	'upstream_error',
	'guard_refusal',
] as const

export type McpToolErrorClass = (typeof MCP_TOOL_ERROR_CLASSES)[number]

export function classifyMcpToolError(
	error: JsonRpcErrorLike | undefined,
): McpToolErrorClass | null {
	const msg = error?.message
	if (typeof msg !== 'string' || msg.length === 0) return null

	// A write the tool refused before touching anything ("update_objects wrote nothing ... Nothing
	// was written."). Not an upstream failure and not a schema failure.
	if (/\bwrote nothing\b|\bnothing was written\b/i.test(msg)) return 'guard_refusal'

	// The tools report API failures as "API error <status>: <message>".
	const status = msg.match(/\bAPI error (\d{3})\b/i)?.[1]
	if (status) {
		const code = Number(status)
		if (code === 401 || code === 403) return 'permission_denied'
		if (code === 404) return 'not_found'
		if (code === 429) return 'rate_limited'
		if (code >= 500) return 'upstream_error'
		return null
	}
	return null
}
