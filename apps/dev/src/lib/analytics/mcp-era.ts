import type { McpEra, McpProtocolVersionLabel } from '@maskin/shared'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'

// Which MCP protocol era a request belongs to, for the `mcp_era` and
// `mcp_protocol_version` properties on the MCP analytics events.
//
// This file is the ONLY place the era rule exists. The later router for the
// 2026-07-28 migration imports `classifyMcpEra` rather than deciding on its
// own: if analytics and routing each decided, "modern on 50 calls" could say
// yes while routing says no.
//
// Privacy contract, same as `mcp-client.ts`: the raw header value is NEVER
// returned or stored. Whatever the client declared is mapped onto a fixed label
// set, so no header text can reach analytics through this function.

/** First protocol version of the modern era. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28'

// Built from the SDK's own constant so an SDK bump that adds a version needs no
// edit here. `__tests__/lib/analytics/mcp-era.test.ts` fails if this list and
// the static label list in @maskin/shared ever differ.
export const MCP_PROTOCOL_VERSION_ALLOWLIST: readonly string[] = [
	...SUPPORTED_PROTOCOL_VERSIONS,
	MODERN_PROTOCOL_VERSION,
]

export interface McpEraClassification {
	era: McpEra
	version: McpProtocolVersionLabel
}

const PROTOCOL_VERSION_HEADER = 'mcp-protocol-version'
const DATE_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/

// JSON-RPC methods that open a connection. `server/discover` is the modern
// handshake; `initialize` is the legacy one.
export const MODERN_HANDSHAKE_METHOD = 'server/discover'
export const LEGACY_HANDSHAKE_METHOD = 'initialize'

/**
 * Classify one HTTP request.
 *
 *   - method `server/discover`, or a declared version at or above 2026-07-28:
 *     modern.
 *   - method `initialize`, or a declared older version: legacy.
 *   - no header and no handshake: legacy, version `none` (the spec lets a
 *     server assume an older default).
 *
 * The version label comes from the allowlist only; a value outside it is
 * `other`. The era still reads the declared date, so a future version such as
 * 2027-01-01 is `modern` / `other` rather than silently counted as legacy.
 * A header that is not a date at all says nothing about the era, so it falls
 * through to the method rule.
 */
export function classifyMcpEra(
	headers: Pick<Headers, 'get'>,
	method: string | undefined,
): McpEraClassification {
	const declared = headers.get(PROTOCOL_VERSION_HEADER)?.trim() || null

	const version: McpProtocolVersionLabel = declared
		? MCP_PROTOCOL_VERSION_ALLOWLIST.includes(declared)
			? (declared as McpProtocolVersionLabel)
			: 'other'
		: 'none'

	if (method === MODERN_HANDSHAKE_METHOD) return { era: 'modern', version }
	if (declared && DATE_VERSION_RE.test(declared)) {
		return { era: declared >= MODERN_PROTOCOL_VERSION ? 'modern' : 'legacy', version }
	}
	return { era: 'legacy', version }
}

/**
 * The one method that decides a POST's era. A JSON-RPC batch is a single HTTP
 * request and shares one era, so pick deterministically: a handshake method
 * wins (the era is a property of how the connection opened), otherwise the first
 * message's method.
 */
export function eraMethodOf(body: unknown): string | undefined {
	const messages = (Array.isArray(body) ? body : [body]).filter(
		(m): m is { method?: unknown } => typeof m === 'object' && m !== null && !Array.isArray(m),
	)
	const methods = messages.map((m) => m.method).filter((m): m is string => typeof m === 'string')
	return (
		methods.find((m) => m === MODERN_HANDSHAKE_METHOD || m === LEGACY_HANDSHAKE_METHOD) ??
		methods[0]
	)
}
