import type { IntegrationResponse, ProviderInfo } from '@/lib/api'

/**
 * Whether the agent can use a tool the job needs, as the workspace and the agent
 * stand right now:
 * - ready: connected, and the agent has the tool.
 * - connected_not_on_agent: connected to the workspace, but the agent has no access
 *   to it (connecting never adds it; whoever connected it or an admin does that).
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

/** The agent's own grant on an integration, else its default; undefined when the server did not say. */
export function agentAccessTo(integration: IntegrationResponse, agentId: string) {
	return (
		integration.agentGrants?.find((g) => g.actorId === agentId)?.access ??
		integration.defaultAgentAccess
	)
}

export function integrationToolState({
	provider,
	integrations,
	agentMcpServers,
	agentId,
}: {
	provider: ProviderInfo
	/** Every integration row in the workspace. */
	integrations: IntegrationResponse[]
	/** The agent's tools.mcpServers; absent while the agent has not loaded, which reads as "none". */
	agentMcpServers: Record<string, unknown> | null | undefined
	/**
	 * The agent the tool is for. With it, the agent's access to the integration (its own
	 * grant, else the integration's default) decides whether the provider's tools are
	 * attached to its sessions, as at launch. Without it, only autoInject providers and
	 * the agent's own tool list count.
	 */
	agentId?: string
}): IntegrationToolState {
	const rows = integrations.filter((i) => i.provider === provider.name)
	const active = rows.find((i) => i.status === 'active')
	if (!active) {
		return rows.some((i) => i.status !== 'pending') ? 'needs_reconnect' : 'missing'
	}
	if (active.needsReconnect && (active.missingScopes?.length ?? 0) > 0) return 'needs_reconnect'
	if (agentHasServer(provider, agentMcpServers)) return 'ready'
	const access = agentId ? agentAccessTo(active, agentId) : undefined
	if (access === 'none') return 'connected_not_on_agent'
	if (provider.mcp?.autoInject || (access !== undefined && provider.mcp?.server)) {
		return active.config?.expose_to_agent_sessions === false ? 'sharing_off' : 'ready'
	}
	return 'connected_not_on_agent'
}
