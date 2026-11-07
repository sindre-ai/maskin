// What the /mcp route needs from this package for Claude connector tokens. A separate
// entry point so the route's existing tests, which replace the main '@maskin/auth' module
// with a stub, keep resolving API keys through their stubbed validateApiKey.
export { MCP_FORWARD_HEADER, getMcpForwardMarker } from './forward-marker'
export { isMcpOAuthEnabled, resolveMcpCredential } from './mcp-credential'
export type { McpCredential } from './mcp-credential'
