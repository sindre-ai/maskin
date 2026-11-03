import type { IntegrationResponse, ProviderInfo } from '@/lib/api'

/**
 * Whether the agent can use a tool the job needs, as the workspace and the agent
 * stand right now:
 * - ready: connected, and the agent has the tool.
 * - connected_not_on_agent: connected to the workspace, but the agent's own tool
 *   list does not hold it (connecting never adds it; an admin does that).
 * - sharing_off: connected, injected into agent sessions by default, but the
 *   workspace switched sharing off.
 * - needs_reconnect: a row exists that is no longer live (revoked, expired), or
 *   the live row's sign-in lacks permissions the provider now asks for.
 * - missing: no row, or only an unfinished (pending) connect.
 */
export type IntegrationToolState =
	| 'ready'
	| 'connected_not_on_agent'
	| 'sharing_off'
	| 'needs_reconnect'
	| 'missing'

/** True when one of the agent's tool servers is this provider's server. */
function agentHasServer(
	provider: ProviderInfo,
	agentMcpServers: Record<string, unknown> | null | undefined,
): boolean {
	if (!agentMcpServers) return false
	if (provider.name in agentMcpServers) return true
	const server = provider.mcp?.server
	if (!server || server.type !== 'http') return false
	return Object.values(agentMcpServers).some(
		(entry) =>
			typeof entry === 'object' &&
			entry !== null &&
			(entry as { url?: unknown }).url === server.url,
	)
}

export function integrationToolState({
	provider,
	integrations,
	agentMcpServers,
}: {
	provider: ProviderInfo
	/** Every integration row in the workspace. */
	integrations: IntegrationResponse[]
	/** The agent's tools.mcpServers; absent while the agent has not loaded, which reads as "none". */
	agentMcpServers: Record<string, unknown> | null | undefined
}): IntegrationToolState {
	const rows = integrations.filter((i) => i.provider === provider.name)
	const active = rows.find((i) => i.status === 'active')
	if (!active) {
		return rows.some((i) => i.status !== 'pending') ? 'needs_reconnect' : 'missing'
	}
	if (active.needsReconnect && (active.missingScopes?.length ?? 0) > 0) return 'needs_reconnect'
	if (agentHasServer(provider, agentMcpServers)) return 'ready'
	if (provider.mcp?.autoInject) {
		return active.config?.expose_to_agent_sessions === false ? 'sharing_off' : 'ready'
	}
	return 'connected_not_on_agent'
}
