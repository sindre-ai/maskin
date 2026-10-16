import { ProviderConnectRow } from '@/components/integrations/provider-connect-row'
import { useIntegrations, useProviders } from '@/hooks/use-integrations'
import { useProviderVisibility } from '@/hooks/use-provider-visibility'

interface IntegrationConnectCardProps {
	workspaceId: string
	/** The chat the card is in — where the user lands again after an OAuth round-trip. */
	conversationId: string
	/** Provider name the agent asked to connect, e.g. 'linear'. */
	provider: string
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
}: IntegrationConnectCardProps) {
	const { data: providers } = useProviders()
	const { data: integrations } = useIntegrations(workspaceId)
	const isProviderVisible = useProviderVisibility()

	const info = providers?.find((p) => p.name === provider)
	// Unknown, still loading, or hidden behind a flag this actor doesn't have →
	// render nothing; the message's markdown already says what to connect, so the
	// thread reads fine without the card.
	if (!info || !isProviderVisible(provider)) return null

	const installations = (integrations ?? []).filter(
		(i) => i.provider === provider && i.status === 'active',
	)

	return (
		<div className="mt-2">
			<ProviderConnectRow
				provider={info}
				installations={installations}
				workspaceId={workspaceId}
				returnTo={`/${workspaceId}/chats/${conversationId}`}
				variant="chat"
			/>
		</div>
	)
}
