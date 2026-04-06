import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	useConnectApiKeyIntegration,
	useConnectIntegration,
	useDisconnectIntegration,
	useIntegrations,
	useProviders,
} from '@/hooks/use-integrations'
import type { IntegrationResponse, ProviderInfo } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
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
	const connectApiKey = useConnectApiKeyIntegration(workspaceId)
	const disconnect = useDisconnectIntegration(workspaceId)
	const [showApiKeyDialog, setShowApiKeyDialog] = useState(false)
	const isConnected = !!integration
	const isApiKey = provider.authType === 'api_key'

	return (
		<>
			<div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
				<div className={`h-3 w-3 rounded-full ${isConnected ? 'bg-success' : 'bg-zinc-600'}`} />
				<div className="flex-1">
					<p className="text-sm font-medium text-foreground">{provider.displayName}</p>
					<p className="text-xs text-muted-foreground">
						{isConnected
							? `Connected${integration.externalId ? ` · ${integration.externalId}` : ''}`
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
				) : isApiKey ? (
					<Button size="sm" onClick={() => setShowApiKeyDialog(true)}>
						Connect
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

			{isApiKey && (
				<ApiKeyDialog
					open={showApiKeyDialog}
					onOpenChange={setShowApiKeyDialog}
					provider={provider}
					onSubmit={(values) =>
						connectApiKey.mutate(
							{ provider: provider.name, ...values },
							{ onSuccess: () => setShowApiKeyDialog(false) },
						)
					}
					isPending={connectApiKey.isPending}
				/>
			)}
		</>
	)
}

function ApiKeyDialog({
	open,
	onOpenChange,
	provider,
	onSubmit,
	isPending,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	provider: ProviderInfo
	onSubmit: (values: { apiKey: string; projectId?: string; contextId?: string }) => void
	isPending: boolean
}) {
	const [apiKey, setApiKey] = useState('')
	const [projectId, setProjectId] = useState('')
	const [contextId, setContextId] = useState('')

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault()
		onSubmit({
			apiKey,
			...(projectId ? { projectId } : {}),
			...(contextId ? { contextId } : {}),
		})
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Connect {provider.displayName}</DialogTitle>
				</DialogHeader>
				<form onSubmit={handleSubmit} className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="apiKey">API Key</Label>
						<Input
							id="apiKey"
							type="password"
							placeholder="Enter your API key"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							required
						/>
					</div>
					{provider.name === 'browserbase' && (
						<>
							<div className="space-y-1.5">
								<Label htmlFor="projectId">
									Project ID <span className="text-muted-foreground">(optional)</span>
								</Label>
								<Input
									id="projectId"
									placeholder="e.g. your-project-id"
									value={projectId}
									onChange={(e) => setProjectId(e.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="contextId">
									Browser Context ID <span className="text-muted-foreground">(optional)</span>
								</Label>
								<Input
									id="contextId"
									placeholder="Persistent browser context for LinkedIn session"
									value={contextId}
									onChange={(e) => setContextId(e.target.value)}
								/>
							</div>
						</>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={!apiKey || isPending}>
							Connect
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	)
}
