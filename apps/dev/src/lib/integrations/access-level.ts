import { type AgentAccess, isKeychainMode } from './agent-access'
import { CUSTOM_MCP_PROVIDER } from './custom-mcp'

/**
 * Whether this access level makes no sense for the integration. A saved key or login is on or
 * off (read_write or no row). A custom tool server has the full levels only when Maskin can
 * sit in front of it (an HTTP server at a public address, see isGatewayable); otherwise, like
 * a stdio server that runs inside the container, it is on (read_write) or off (none).
 */
export function levelNotAllowed(
	target: { provider: string; providerMode: string; gated: boolean },
	access: string,
): 'keychain_access' | 'custom_access' | null {
	if (isKeychainMode(target.providerMode as never)) {
		return access !== 'read_write' && access !== 'none' ? 'keychain_access' : null
	}
	if (target.provider === CUSTOM_MCP_PROVIDER && !target.gated && access === 'read') {
		return 'custom_access'
	}
	return null
}

const RANK: Record<AgentAccess, number> = { none: 0, read: 1, read_write: 2 }

/** Whether `have` already covers `want`: read & write covers read, read covers read. */
export function accessCovers(have: AgentAccess, want: AgentAccess): boolean {
	return RANK[have] >= RANK[want]
}
