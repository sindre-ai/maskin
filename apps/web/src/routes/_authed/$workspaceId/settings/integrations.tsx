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
	useGithubPendingSelection,
	useIntegrations,
	useLinkGithubInstallation,
	useLinkableGithubInstallations,
	useProviders,
	useSelectGithubInstallation,
} from '@/hooks/use-integrations'
import type { IntegrationResponse, ProviderInfo } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Check, Copy, Link2, Plus } from 'lucide-react'
import { useState } from 'react'

const SLACK_HISTORY_SCOPES: readonly string[] = [
	'channels:history',
	'groups:history',
	'mpim:history',
]

export const Route = createFileRoute('/_authed/$workspaceId/settings/integrations')({
	component: IntegrationsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	// Both params are set by the GitHub connect callback redirecting back here:
	// `select_github` carries the pending row whose installation choices are
	// awaiting a pick, `error` reports a failed handshake.
	validateSearch: (search: Record<string, unknown>) => ({
		select_github: typeof search.select_github === 'string' ? search.select_github : undefined,
		error: typeof search.error === 'string' ? search.error : undefined,
	}),
})

function IntegrationsPage() {
	const { workspaceId } = useWorkspace()
	const { data: integrations, isLoading: integrationsLoading } = useIntegrations(workspaceId)
	const { data: providers, isLoading: providersLoading } = useProviders()

	// GitHub only installs its App once per org, so a workspace that wants an org
	// someone already connected elsewhere can't go through the install flow — it
	// binds to the existing installation instead.
	const { data: linkable } = useLinkableGithubInstallations(workspaceId)
	const linkableCount = (linkable ?? []).filter((i) => !i.alreadyLinked).length

	// A GitHub connect where the user could reach several orgs' installations
	// comes back here with the pending row id, for them to pick one.
	const { select_github: selectGithubId } = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const closeGithubSelect = () =>
		navigate({ search: (prev) => ({ ...prev, select_github: undefined }), replace: true })

	const isLoading = integrationsLoading || providersLoading
	const [linkGithubOpen, setLinkGithubOpen] = useState(false)
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
									linkableCount={linkableCount}
									onRequestLink={() => setLinkGithubOpen(true)}
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
								linkableCount={provider.name === 'github' ? linkableCount : 0}
								onRequestLink={() => setLinkGithubOpen(true)}
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
			<LinkGithubDialog
				workspaceId={workspaceId}
				open={linkGithubOpen}
				onClose={() => setLinkGithubOpen(false)}
			/>
			<SelectGithubInstallationDialog
				workspaceId={workspaceId}
				integrationId={selectGithubId ?? null}
				onClose={closeGithubSelect}
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
	linkableCount,
	onRequestLink,
}: {
	provider: ProviderInfo
	integration?: IntegrationResponse
	workspaceId: string
	onRequestApiKey: () => void
	onManualConnected: (webhookUrl: string, integrationId: string) => void
	/** Installations bindable to this workspace; 0 for every non-GitHub provider. */
	linkableCount: number
	onRequestLink: () => void
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

	// An install whose token predates a scope the provider now requires still
	// works for everything it was granted, so it stays "connected" — but say
	// plainly that some features are dark and that reconnecting is the fix.
	// Reconnecting runs the normal OAuth flow, which updates this row in place.
	const missingCount = integration?.missingScopes?.length ?? 0
	const needsReconnect = Boolean(integration?.needsReconnect) && missingCount > 0

	// Slack agents need channel history to dedupe threads and load context. When
	// that specific slice of scopes is missing the generic "grant N permissions"
	// copy is too abstract to prompt action — name what the reconnect unlocks.
	const missingSlackHistoryScopes =
		provider.name === 'slack' &&
		integration?.missingScopes?.some((scope) => SLACK_HISTORY_SCOPES.includes(scope))

	// LinkedIn is the one provider that costs money to connect — $49 per
	// connected identity per month, added to the workspace subscription. A
	// price has to be stated before the click that incurs it, not only on the
	// billing page afterwards, so it is rendered on the card in both states:
	// as a price before connecting, as a statement of what is being billed
	// after. Kept in sync with LINKEDIN_IDENTITY_UNIT_PRICE_USD_CENTS in
	// apps/dev/src/lib/linkedin-addon.ts.
	const isPaidIdentityAddon = provider.name === 'linkedin-unipile'

	const connectedLabel = isConnected
		? needsReconnect
			? missingSlackHistoryScopes
				? 'Reconnect required — Slack agents need history access to read channel backlog.'
				: `Update needed — reconnect to grant ${missingCount} new permission${missingCount === 1 ? '' : 's'}`
			: provider.externalIdDisplay === 'email' && integration.externalId
				? `Connected as ${integration.externalId}`
				: `Connected${integration.externalId ? ` · Installation ${integration.externalId}` : ''}`
		: provider.events.length > 0
			? `${provider.events.length} event types available`
			: 'Available to connect'

	return (
		<div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
			<div
				className={`h-3 w-3 shrink-0 rounded-full ${
					needsReconnect ? 'bg-warning' : isConnected ? 'bg-success' : 'bg-zinc-600'
				}`}
			/>
			<div className="flex-1 min-w-0">
				<p className="text-sm font-medium text-foreground truncate">{provider.displayName}</p>
				<p
					className={`text-xs truncate ${needsReconnect ? 'text-warning' : 'text-muted-foreground'}`}
					title={needsReconnect ? integration?.missingScopes?.join(', ') : undefined}
				>
					{connectedLabel}
				</p>
				{isPaidIdentityAddon && (
					<p className="text-xs text-muted-foreground">
						{isConnected
							? '$49/month per connected identity, billed on your Maskin subscription. Disconnecting stops the charge at the end of the current period.'
							: '$49/month per connected identity, added to your Maskin subscription.'}
					</p>
				)}
			</div>
			{isConnected ? (
				<div className="flex shrink-0 items-center gap-2">
					{needsReconnect && (
						<Button
							variant="outline"
							size="sm"
							onClick={handleConnect}
							disabled={connect.isPending}
						>
							Reconnect
						</Button>
					)}
					<Button
						variant="ghost"
						size="sm"
						className="text-muted-foreground hover:text-error"
						onClick={() => disconnect.mutate(integration.id)}
						disabled={disconnect.isPending}
					>
						Disconnect
					</Button>
				</div>
			) : (
				<div className="flex shrink-0 items-center gap-2">
					{linkableCount > 0 && (
						<Button variant="outline" size="sm" onClick={onRequestLink}>
							<Link2 className="mr-1 h-3.5 w-3.5" />
							Add existing
						</Button>
					)}
					<Button size="sm" onClick={handleConnect} disabled={connect.isPending}>
						Connect
					</Button>
				</div>
			)}
		</div>
	)
}

function GroupedProviderRow({
	provider,
	installations,
	workspaceId,
	linkableCount,
	onRequestLink,
}: {
	provider: ProviderInfo
	installations: IntegrationResponse[]
	workspaceId: string
	linkableCount: number
	onRequestLink: () => void
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
					<div className="flex flex-col gap-2 md:flex-row">
						<Button
							variant="outline"
							size="sm"
							className="w-full md:flex-1"
							onClick={() => connect.mutate({ provider: provider.name })}
							disabled={connect.isPending}
						>
							<Plus className="h-3.5 w-3.5 mr-1" />
							Add another
						</Button>
						{linkableCount > 0 && (
							<Button
								variant="outline"
								size="sm"
								className="w-full md:flex-1"
								onClick={onRequestLink}
							>
								<Link2 className="h-3.5 w-3.5 mr-1" />
								Add existing
							</Button>
						)}
					</div>
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

/** Bind a GitHub App installation the actor already reaches from one of their
 *  other workspaces. GitHub refuses to re-run its install flow for an org that
 *  already has the App, so this is the only path to a second workspace. */
/** Finalizes a GitHub connect where the authorizing user could reach more than
 *  one installation. The candidates come from GitHub's own answer to "which
 *  installations can this user access", so anything listed here is already
 *  authorized — picking one just says which org this workspace meant. */
function SelectGithubInstallationDialog({
	workspaceId,
	integrationId,
	onClose,
}: {
	workspaceId: string
	integrationId: string | null
	onClose: () => void
}) {
	const { data, isLoading } = useGithubPendingSelection(workspaceId, integrationId)
	const select = useSelectGithubInstallation(workspaceId)
	const options = data?.installations ?? []

	return (
		<Dialog open={!!integrationId} onOpenChange={(next) => !next && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Choose a GitHub organization</DialogTitle>
					<DialogDescription>
						You have access to the Maskin GitHub App in more than one organization. Pick the one
						this workspace should use — nothing changes on GitHub.
					</DialogDescription>
				</DialogHeader>
				{isLoading ? (
					<ListSkeleton />
				) : options.length === 0 ? (
					<EmptyState
						title="Nothing to choose"
						description="This connection attempt has already been completed or has expired"
					/>
				) : (
					<div className="space-y-2">
						{options.map((installation) => (
							<div
								key={installation.installationId}
								className="flex items-center gap-3 rounded-md border border-border bg-bg-surface p-3"
							>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium text-foreground">
										{installation.ownerLogin ?? `Installation ${installation.installationId}`}
									</p>
									<p className="truncate text-xs text-muted-foreground">
										Installation {installation.installationId}
									</p>
								</div>
								<Button
									size="sm"
									className="shrink-0"
									onClick={() =>
										integrationId &&
										select.mutate(
											{ integrationId, installationId: installation.installationId },
											{ onSuccess: onClose },
										)
									}
									disabled={select.isPending}
								>
									Connect
								</Button>
							</div>
						))}
					</div>
				)}
				<div className="flex justify-end">
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}

function LinkGithubDialog({
	workspaceId,
	open,
	onClose,
}: {
	workspaceId: string
	open: boolean
	onClose: () => void
}) {
	const { data, isLoading } = useLinkableGithubInstallations(workspaceId)
	const link = useLinkGithubInstallation(workspaceId)
	const options = (data ?? []).filter((installation) => !installation.alreadyLinked)

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add an existing GitHub organization</DialogTitle>
					<DialogDescription>
						These organizations already have the Maskin GitHub App installed from another of your
						workspaces. Adding one here reuses that installation — nothing changes on GitHub.
					</DialogDescription>
				</DialogHeader>
				{isLoading ? (
					<ListSkeleton />
				) : options.length === 0 ? (
					<EmptyState
						title="Nothing to add"
						description="Every organization you've connected is already in this workspace"
					/>
				) : (
					<div className="space-y-2">
						{options.map((installation) => (
							<div
								key={installation.installationId}
								className="flex items-center gap-3 rounded-md border border-border bg-bg-surface p-3"
							>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium text-foreground">
										{installation.ownerLogin ?? `Installation ${installation.installationId}`}
									</p>
									<p className="truncate text-xs text-muted-foreground">
										Installation {installation.installationId}
									</p>
								</div>
								<Button
									size="sm"
									className="shrink-0"
									onClick={() =>
										link.mutate(installation.installationId, {
											onSuccess: () => {
												if (options.length === 1) onClose()
											},
										})
									}
									disabled={link.isPending}
								>
									Add
								</Button>
							</div>
						))}
					</div>
				)}
				<div className="flex justify-end">
					<Button variant="ghost" onClick={onClose}>
						Done
					</Button>
				</div>
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
