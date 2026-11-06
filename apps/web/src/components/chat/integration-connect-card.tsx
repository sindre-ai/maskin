import { AddToAgentButton, useCanGiveAgentAccess } from '@/components/chat/add-to-agent-button'
import { ProviderConnectRow } from '@/components/integrations/provider-connect-row'
import { useIntegrations, useProviders } from '@/hooks/use-integrations'
import type { IntegrationResponse } from '@/lib/api'
import type { IntegrationToolState } from '@/lib/integration-tool-state'

interface IntegrationConnectCardProps {
	workspaceId: string
	/** The chat the card is in — where the user lands again after an OAuth round-trip. */
	conversationId: string
	/** Provider name the agent asked to connect, e.g. 'linear'. */
	provider: string
	/** Draws the quiet row of an agent intro instead of the full card. */
	introState?: IntegrationToolState
	/** The agent the intro is for: a connected tool it has no access to gets an Add to agent button. */
	agent?: { id: string; name: string }
}

/**
 * The Connect card an agent puts in chat via `connect_integration`.
 *
 * It is the same per-provider row Settings → Integrations renders, so every
 * provider connects exactly as it does there: a sign-in button for OAuth, a key
 * input for API-key providers, the price shown before connecting LinkedIn, the
 * Skjald and Resend walkthroughs, GitHub's "add existing". Once connected it
 * shows a disabled "Connected" button, plus "+ Add another" for providers that
 * allow more than one install.
 *
 * Status is read live rather than stored on the message, so the card turns to
 * "Connected" by itself and a scrolled-back thread never shows a stale Connect
 * button. An API key goes straight to the connect endpoint — never through the
 * agent.
 */
export function IntegrationConnectCard({
	workspaceId,
	conversationId,
	provider,
	introState,
	agent,
}: IntegrationConnectCardProps) {
	const { data: providers } = useProviders()
	const { data: integrations } = useIntegrations(workspaceId)
	const canGiveAccess = useCanGiveAgentAccess()

	const info = providers?.find((p) => p.name === provider)
	// Unknown or still loading → render nothing; the message's markdown already
	// says what to connect, so the thread reads fine without the card.
	if (!info) return null

	const installations = (integrations ?? []).filter(
		(i) => i.provider === provider && i.status === 'active',
	)

	// A row that is no longer live (revoked, expired) means the user is signing in
	// again, not for the first time. A pending row is just an unfinished connect.
	const reconnect =
		installations.length === 0 &&
		(integrations ?? []).some(
			(i) => i.provider === provider && i.status !== 'active' && i.status !== 'pending',
		)

	const addToAgent =
		introState === 'connected_not_on_agent' && agent && canGiveAccess(installations[0]) ? (
			<AddToAgentButton
				workspaceId={workspaceId}
				integration={installations[0] as IntegrationResponse}
				toolName={info.displayName}
				agentId={agent.id}
				agentName={agent.name}
			/>
		) : undefined

	return (
		<div className="mt-2">
			<ProviderConnectRow
				provider={info}
				installations={installations}
				workspaceId={workspaceId}
				returnTo={`/${workspaceId}/chats/${conversationId}`}
				variant="chat"
				reconnect={reconnect}
				introState={introState}
				introAction={addToAgent}
			/>
		</div>
	)
}
