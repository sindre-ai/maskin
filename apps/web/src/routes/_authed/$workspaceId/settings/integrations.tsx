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
import { Plus } from 'lucide-react'
import { useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/integrations')({
	component: IntegrationsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function IntegrationsPage() {
	const { workspaceId } = useWorkspace()
	const { data: integrations, isLoading: integrationsLoading } = useIntegrations(workspaceId)
	const { data: providers, isLoading: providersLoading } = useProviders()

	const isLoading = integrationsLoading || providersLoading

	// Group active integrations by provider — GitHub can have multiple installations,
	// other providers currently have one.
	const activeByProvider = new Map<string, IntegrationResponse[]>()
	for (const integration of integrations ?? []) {
		if (integration.status !== 'active') continue
		const existing = activeByProvider.get(integration.provider) ?? []
		existing.push(integration)
		activeByProvider.set(integration.provider, existing)
	}

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
					{providers.map((provider) => {
						const installations = activeByProvider.get(provider.name) ?? []
						if (provider.name === 'github' && installations.length > 0) {
							return (
								<GroupedProviderRow
									key={provider.name}
									provider={provider}
									installations={installations}
									workspaceId={workspaceId}
								/>
							)
						}
						return (
							<ProviderRow
								key={provider.name}
								provider={provider}
								integration={installations[0]}
								workspaceId={workspaceId}
							/>
						)
					})}
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
				className={`h-3 w-3 shrink-0 rounded-full ${isConnected ? 'bg-success' : 'bg-zinc-600'}`}
			/>
			<div className="flex-1 min-w-0">
				<p className="text-sm font-medium text-foreground truncate">{provider.displayName}</p>
				<p className="text-xs text-muted-foreground truncate">
					{isConnected
						? `Connected${integration.externalId ? ` · Installation ${integration.externalId}` : ''}`
						: `${provider.events.length} event types available`}
				</p>
			</div>
			{isConnected ? (
				<Button
					variant="ghost"
					size="sm"
					className="shrink-0 text-muted-foreground hover:text-error"
					onClick={() => disconnect.mutate(integration.id)}
					disabled={disconnect.isPending}
				>
					Disconnect
				</Button>
			) : (
				<Button
					size="sm"
					className="shrink-0"
					onClick={() => connect.mutate(provider.name)}
					disabled={connect.isPending}
				>
					Connect
				</Button>
			)}
		</div>
	)
}

function GroupedProviderRow({
	provider,
	installations,
	workspaceId,
}: {
	provider: ProviderInfo
	installations: IntegrationResponse[]
	workspaceId: string
}) {
	const connect = useConnectIntegration(workspaceId)
	const disconnect = useDisconnectIntegration(workspaceId)
	const [expanded, setExpanded] = useState(installations.length > 1)
	const count = installations.length

	return (
		<div className="overflow-hidden rounded-lg border border-border bg-card">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-bg-hover"
			>
				<div className="h-3 w-3 shrink-0 rounded-full bg-success" />
				<div className="flex-1 min-w-0">
					<p className="text-sm font-medium text-foreground truncate">
						{provider.displayName} · {count}
					</p>
					<p className="text-xs text-muted-foreground truncate">
						{count} active installation{count === 1 ? '' : 's'}
					</p>
				</div>
			</button>
			{expanded && (
				<div className="space-y-2 border-t border-border p-2">
					{installations.map((installation) => (
						<NestedInstallationRow
							key={installation.id}
							integration={installation}
							onDisconnect={() => disconnect.mutate(installation.id)}
							disconnecting={disconnect.isPending}
						/>
					))}
					<Button
						variant="outline"
						size="sm"
						className="w-full"
						onClick={() => connect.mutate(provider.name)}
						disabled={connect.isPending}
					>
						<Plus className="h-3.5 w-3.5 mr-1" />
						Add another
					</Button>
				</div>
			)}
		</div>
	)
}

function NestedInstallationRow({
	integration,
	onDisconnect,
	disconnecting,
}: {
	integration: IntegrationResponse
	onDisconnect: () => void
	disconnecting: boolean
}) {
	const ownerLogin =
		typeof integration.config.owner_login === 'string' ? integration.config.owner_login : undefined
	const label =
		ownerLogin ??
		(integration.externalId ? `Installation ${integration.externalId}` : 'Installation')

	return (
		<div className="flex items-center gap-3 rounded-md border border-border bg-bg-surface p-3">
			<div className="h-3 w-3 shrink-0 rounded-full bg-success" />
			<div className="flex-1 min-w-0">
				<p className="text-sm font-medium text-foreground truncate">{label}</p>
				{integration.externalId && (
					<p className="text-xs text-muted-foreground truncate">
						Installation {integration.externalId}
					</p>
				)}
			</div>
			<Button
				variant="ghost"
				size="sm"
				className="shrink-0 text-muted-foreground hover:text-error"
				onClick={onDisconnect}
				disabled={disconnecting}
			>
				Disconnect
			</Button>
		</div>
	)
}
