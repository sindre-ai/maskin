import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import {
	useConnectIntegration,
	useDisconnectIntegration,
	useIntegrations,
	useProviders,
} from '@/hooks/use-integrations'
import type { IntegrationResponse, ProviderInfo } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/integrations')({
	component: IntegrationsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function IntegrationsPage() {
	const { workspaceId } = useWorkspace()
	const { data: integrations, isLoading: integrationsLoading } = useIntegrations(workspaceId)
	const { data: providers, isLoading: providersLoading } = useProviders()

	const isLoading = integrationsLoading || providersLoading

	// Map connected integrations by provider name
	const connectedMap = new Map(
		(integrations ?? []).filter((i) => i.status === 'active').map((i) => [i.provider, i]),
	)

	return (
		<div>
			{isLoading ? (
				<ListSkeleton />
			) : !providers?.length ? (
				<EmptyState
					title="No providers available"
					description="No integration providers are configured on the server"
				/>
			) : (
				<div className="space-y-2">
					{providers.map((provider) => (
						<ProviderRow
							key={provider.name}
							provider={provider}
							integration={connectedMap.get(provider.name)}
							workspaceId={workspaceId}
						/>
					))}
				</div>
			)}
		</div>
	)
}

function ProviderRow({
	provider,
	integration,
	workspaceId,
}: {
	provider: ProviderInfo
	integration?: IntegrationResponse
	workspaceId: string
}) {
	const connect = useConnectIntegration(workspaceId)
	const disconnect = useDisconnectIntegration(workspaceId)
	const isConnected = !!integration

	return (
		<div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
			<div
				className={`h-3 w-3 rounded-full ${isConnected ? 'bg-success' : 'bg-muted-foreground'}`}
			/>
			<div className="flex-1">
				<p className="text-sm font-medium text-foreground">{provider.displayName}</p>
				<p className="text-xs text-muted-foreground">
					{isConnected
						? `Connected${integration.externalId ? ` · Installation ${integration.externalId}` : ''}`
						: `${provider.events.length} event types available`}
				</p>
			</div>
			{isConnected ? (
				<Button
					variant="ghost"
					size="sm"
					className="text-muted-foreground hover:text-error"
					onClick={() => disconnect.mutate(integration.id)}
					disabled={disconnect.isPending}
				>
					Disconnect
				</Button>
			) : (
				<Button
					size="sm"
					onClick={() => connect.mutate(provider.name)}
					disabled={connect.isPending}
				>
					Connect
				</Button>
			)}
		</div>
	)
}
