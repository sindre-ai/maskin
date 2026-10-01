import { capturePosthogEvent } from './posthog'

export interface IntegrationConnectedProps {
	provider: string
	workspaceId: string
	actorId: string
	integrationId: string
}

/**
 * Fire `integration_connected` on successful integration credential landing.
 *
 * The bet's Signals Scout section names this as the observable half of the
 * "connect + send" win criterion — without it, a successful connect and a
 * successful send collapse into a single downstream `mcp_tool_call_response_size`
 * signal and we can't tell which half worked. Distinct id is the actor (the
 * connecting human), matching the actor-scoped credential model.
 *
 * Best-effort per capturePosthogEvent — never throws.
 */
export async function trackIntegrationConnected(p: IntegrationConnectedProps): Promise<void> {
	await capturePosthogEvent('integration_connected', p.actorId, {
		provider: p.provider,
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		integration_id: p.integrationId,
	})
}
