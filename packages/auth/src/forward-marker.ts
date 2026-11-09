import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * A per-process random secret that only the /mcp forwarder knows. The forwarder adds it
 * to the REST calls it makes on localhost; authMiddleware requires it for any mat_ token.
 * So a leaked mat_ token works through /mcp and nowhere else on the API.
 *
 * It sits on top of the workspace pin and the route allowlist, not instead of them. It
 * is never persisted or logged, and it changes on every restart.
 */
export const MCP_FORWARD_HEADER = 'X-Maskin-Mcp-Forward'

const marker = randomBytes(32).toString('base64url')

/** The marker for this process. Pass it to the in-process MCP server as its forward marker. */
export function getMcpForwardMarker(): string {
	return marker
}

const digest = (value: string) => createHash('sha256').update(value).digest()

export function isValidMcpForwardMarker(candidate: string | null | undefined): boolean {
	if (!candidate) return false
	return timingSafeEqual(digest(candidate), digest(marker))
}
