import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	useCompleteIntegration,
	useConnectIntegration,
	useDisconnectIntegration,
	useIntegrations,
	useProviders,
} from '@/hooks/use-integrations'
import type { IntegrationResponse, ProviderInfo } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { Check, Copy, Plus } from 'lucide-react'
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
	const [apiKeyProvider, setApiKeyProvider] = useState<ProviderInfo | null>(null)
	const [apiKey, setApiKey] = useState('')
	const [manualConnect, setManualConnect] = useState<{
		provider: ProviderInfo
		webhookUrl: string
		integrationId: string
	} | null>(null)

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
								onRequestApiKey={() => {
									setApiKeyProvider(provider)
									setApiKey('')
								}}
								onManualConnected={(webhookUrl, integrationId) =>
									setManualConnect({ provider, webhookUrl, integrationId })
								}
							/>
						)
					})}
				</div>
			)}
			<ApiKeyDialog
				workspaceId={workspaceId}
				provider={apiKeyProvider}
				apiKey={apiKey}
				onApiKeyChange={setApiKey}
				onClose={() => {
					setApiKeyProvider(null)
					setApiKey('')
				}}
			/>
			<SkjaldConnectDialog
				workspaceId={workspaceId}
				state={manualConnect}
				onClose={() => setManualConnect(null)}
			/>
		</div>
	)
}

function ProviderRow({
	provider,
	integration,
	workspaceId,
	onRequestApiKey,
	onManualConnected,
}: {
	provider: ProviderInfo
	integration?: IntegrationResponse
	workspaceId: string
	onRequestApiKey: () => void
	onManualConnected: (webhookUrl: string, integrationId: string) => void
}) {
	const connect = useConnectIntegration(workspaceId)
	const disconnect = useDisconnectIntegration(workspaceId)
	const isConnected = !!integration
	const handleConnect = () => {
		if (provider.authType === 'api_key') {
			onRequestApiKey()
			return
		}
		if (provider.authType === 'manual') {
			connect.mutate(
				{ provider: provider.name },
				{
					onSuccess: (data) => {
						if (data.webhook_url && data.integration_id) {
							onManualConnected(data.webhook_url, data.integration_id)
						}
					},
				},
			)
			return
		}
		connect.mutate({ provider: provider.name })
	}

	const connectedLabel = isConnected
		? provider.externalIdDisplay === 'email' && integration.externalId
			? `Connected as ${integration.externalId}`
			: `Connected${integration.externalId ? ` · Installation ${integration.externalId}` : ''}`
		: provider.events.length > 0
			? `${provider.events.length} event types available`
			: 'Available to connect'

	return (
		<div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
			<div
				className={`h-3 w-3 shrink-0 rounded-full ${isConnected ? 'bg-success' : 'bg-zinc-600'}`}
			/>
			<div className="flex-1 min-w-0">
				<p className="text-sm font-medium text-foreground truncate">{provider.displayName}</p>
				<p className="text-xs text-muted-foreground truncate">{connectedLabel}</p>
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
				<Button size="sm" className="shrink-0" onClick={handleConnect} disabled={connect.isPending}>
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
						onClick={() => connect.mutate({ provider: provider.name })}
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

function ApiKeyDialog({
	workspaceId,
	provider,
	apiKey,
	onApiKeyChange,
	onClose,
}: {
	workspaceId: string
	provider: ProviderInfo | null
	apiKey: string
	onApiKeyChange: (value: string) => void
	onClose: () => void
}) {
	const connect = useConnectIntegration(workspaceId)

	const open = !!provider
	const handleConnect = () => {
		if (!provider) return
		connect.mutate(
			{ provider: provider.name, apiKey },
			{
				onSuccess: () => {
					onClose()
				},
			},
		)
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Connect {provider?.displayName}</DialogTitle>
					<DialogDescription>
						Enter your PostHog personal API key to store it for this workspace only.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					<Label htmlFor="posthog-api-key">API key</Label>
					<Input
						id="posthog-api-key"
						type="password"
						value={apiKey}
						onChange={(e) => onApiKeyChange(e.target.value)}
						placeholder="phx_..."
					/>
				</div>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button onClick={handleConnect} disabled={!apiKey.trim() || connect.isPending}>
						Connect
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}

const SKJALD_SETUP_STEPS = [
	'In Skjald, go to Settings → Webhooks → Add Webhook and paste the URL below.',
	'Subscribe to the transcription.completed event.',
	'Set payload mode to "Full content" so the transcript is included.',
	'Copy the secret Skjald generates and paste it below to finish connecting.',
]

function SkjaldConnectDialog({
	workspaceId,
	state,
	onClose,
}: {
	workspaceId: string
	state: { provider: ProviderInfo; webhookUrl: string; integrationId: string } | null
	onClose: () => void
}) {
	const complete = useCompleteIntegration(workspaceId)
	const [step, setStep] = useState<1 | 2>(1)
	const [secret, setSecret] = useState('')
	const [copied, setCopied] = useState(false)

	const open = !!state

	const handleClose = () => {
		onClose()
		setStep(1)
		setSecret('')
		setCopied(false)
	}

	const handleCopy = () => {
		if (!state) return
		navigator.clipboard.writeText(state.webhookUrl)
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}

	const handleComplete = () => {
		if (!state) return
		complete.mutate(
			{ id: state.integrationId, secret },
			{
				onSuccess: handleClose,
			},
		)
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Connect {state?.provider.displayName}</DialogTitle>
					<DialogDescription>
						{step === 1
							? 'Set up a webhook in Skjald pointing at this URL.'
							: 'Paste the secret Skjald generated to finish connecting.'}
					</DialogDescription>
				</DialogHeader>
				{step === 1 ? (
					<div className="space-y-3">
						<div className="space-y-2">
							<Label>Webhook URL</Label>
							<div className="flex gap-2">
								<div className="flex-1 min-w-0 rounded-md border border-border bg-bg-surface px-3 py-2 font-mono text-xs break-all select-all">
									{state?.webhookUrl}
								</div>
								<Button variant="secondary" size="sm" className="shrink-0" onClick={handleCopy}>
									{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
								</Button>
							</div>
						</div>
						<ol className="list-decimal list-inside space-y-1.5 text-xs text-muted-foreground">
							{SKJALD_SETUP_STEPS.map((instruction) => (
								<li key={instruction}>{instruction}</li>
							))}
						</ol>
						<div className="flex justify-end gap-2">
							<Button variant="ghost" onClick={handleClose}>
								Cancel
							</Button>
							<Button onClick={() => setStep(2)}>Next</Button>
						</div>
					</div>
				) : (
					<div className="space-y-3">
						<div className="space-y-2">
							<Label htmlFor="skjald-secret">Webhook secret</Label>
							<Input
								id="skjald-secret"
								type="password"
								value={secret}
								onChange={(e) => setSecret(e.target.value)}
								placeholder="Paste the secret from Skjald"
							/>
						</div>
						<div className="flex justify-end gap-2">
							<Button variant="ghost" onClick={() => setStep(1)}>
								Back
							</Button>
							<Button onClick={handleComplete} disabled={!secret.trim() || complete.isPending}>
								Connect
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
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
