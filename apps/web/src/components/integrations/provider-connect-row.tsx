import { AgentAccess } from '@/components/integrations/agent-access'
import { StatusPill } from '@/components/integrations/drive/status-pill'
import { ProviderCard } from '@/components/integrations/provider-card'
import {
	ApiKeyDialog,
	DeepdotsConnectDialog,
	InstallGithubOrgButton,
	LinkGithubDialog,
	SkjaldConnectDialog,
} from '@/components/integrations/provider-dialogs'
import { ResendConnectDialog } from '@/components/integrations/resend/resend-connect-dialog'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useActors } from '@/hooks/use-actors'
import { useAuth } from '@/hooks/use-auth'
import { useCanWrite } from '@/hooks/use-can-write'
import { useIdentityAddonPricing } from '@/hooks/use-identity-addon-pricing'
import {
	useConnectIntegration,
	useDisconnectIntegration,
	useLinkableGithubInstallations,
} from '@/hooks/use-integrations'
import type { IntegrationResponse, ProviderInfo } from '@/lib/api'
import { cn } from '@/lib/cn'
import { DRIVE_COPY } from '@/lib/drive-copy'
import { DRIVE_PROVIDER } from '@/lib/drive-humans'
import type { IntegrationToolState } from '@/lib/integration-tool-state'
import { PILL_BUTTON } from '@/lib/pill-button'
import { MULTI_INSTALL_PROVIDERS } from '@maskin/shared'
import { Link } from '@tanstack/react-router'
import { Check, ChevronDown, Link2, Plus } from 'lucide-react'
import { useState } from 'react'

const SLACK_HISTORY_SCOPES: readonly string[] = [
	'channels:history',
	'groups:history',
	'mpim:history',
]

const INTRO_SUBTITLES: Record<IntegrationToolState, string> = {
	ready: 'Connected, ready to use',
	connected_not_on_agent: 'Connected to the workspace',
	sharing_off: 'Connected to the workspace',
	needs_reconnect: 'Needs reconnecting',
	missing: 'Not connected yet',
}

/** What each tool is for, in a few words (mockup Settings, Integrations). */
const PROVIDER_TAGLINES: Record<string, string> = {
	github: 'Pull requests',
	gmail: 'Drafts and sending',
	'google-drive': 'Files',
	'linkedin-unipile': 'Posting and outreach',
	linear: 'Issues',
	posthog: 'Product analytics',
	resend: 'Email sending',
	slack: 'Channels and triggers',
}

export function ProviderRow({
	provider,
	integration,
	workspaceId,
	onRequestApiKey,
	onRequestSkjaldConnect,
	onRequestResendConnect,
	onRequestDeepdotsConnect,
	linkableCount,
	onRequestLink,
	returnTo,
	variant = 'settings',
	reconnect = false,
	introState,
}: {
	provider: ProviderInfo
	integration?: IntegrationResponse
	workspaceId: string
	onRequestApiKey: () => void
	/** Skjald connects from the Skjald app, so Connect opens a dialog that says where to
	 *  tap rather than calling /connect. Undefined for every other provider. */
	onRequestSkjaldConnect?: () => void
	/** Resend needs its own multi-step dialog — bypass the manual-branch /connect
	 *  round-trip and hand off to the caller's ResendConnectDialog state.
	 *  Undefined for every other provider. */
	onRequestResendConnect?: () => void
	/** Deepdots signs in with an email and password, so Connect opens a two-field form. */
	onRequestDeepdotsConnect?: () => void
	/** Installations bindable to this workspace; 0 for every non-GitHub provider. */
	linkableCount: number
	onRequestLink: () => void
	/** Where the connect flow should land afterwards; absent means Settings → Integrations. */
	returnTo?: string
	/** `chat` swaps Disconnect for a read-only "Connected" state — disconnecting stays in Settings. */
	variant?: 'settings' | 'chat'
	/** The workspace has a row for this provider that is no longer active, so the sign-in button reads Reconnect. */
	reconnect?: boolean
	/** Draws the quiet row of an agent intro: tighter, an outline Connect and plain state subtitles. */
	introState?: IntegrationToolState
}) {
	const connect = useConnectIntegration(workspaceId)
	const disconnect = useDisconnectIntegration(workspaceId)
	const canWrite = useCanWrite()
	const isConnected = !!integration
	// The Drive card carries a pill, a one-line pitch and a link to its detail page
	// in Settings; the chat card stays the plain row every provider gets.
	const isDrive = provider.name === DRIVE_PROVIDER && variant === 'settings'
	const driveDetailsLink = isDrive ? (
		<Button asChild variant="outline" size="sm" className={PILL_BUTTON}>
			<Link to="/$workspaceId/settings/integrations/google-drive" params={{ workspaceId }}>
				Details
			</Link>
		</Button>
	) : null
	const handleConnect = () => {
		if (provider.authType === 'api_key') {
			onRequestApiKey()
			return
		}
		if (provider.name === 'resend' && onRequestResendConnect) {
			onRequestResendConnect()
			return
		}
		if (provider.name === 'skjald' && onRequestSkjaldConnect) {
			onRequestSkjaldConnect()
			return
		}
		if (provider.name === 'deepdots' && onRequestDeepdotsConnect) {
			onRequestDeepdotsConnect()
			return
		}
		connect.mutate({ provider: provider.name, returnTo })
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

	// The $49/identity price has to be stated before the click that incurs it, on
	// the card in both states — see useIdentityAddonPricing for the rules.
	const { isFree: isFreeIdentityAddon, isPaid: isPaidIdentityAddon } = useIdentityAddonPricing(
		workspaceId,
		provider.name,
	)

	const connectedLabel = isConnected
		? needsReconnect
			? missingSlackHistoryScopes
				? 'Reconnect required — Slack agents need history access to read channel backlog.'
				: `Update needed — reconnect to grant ${missingCount} new permission${missingCount === 1 ? '' : 's'}`
			: provider.externalIdDisplay === 'email' && integration.externalId
				? `Connected as ${integration.externalId}`
				: integration.externalId
					? `Connected · Installation ${integration.externalId}`
					: (variant === 'settings' && PROVIDER_TAGLINES[provider.name]) || 'Connected'
		: variant === 'settings' && PROVIDER_TAGLINES[provider.name]
			? PROVIDER_TAGLINES[provider.name]
			: provider.events.length > 0
				? `${provider.events.length} event types available`
				: 'Available to connect'

	// The intro's quiet row says plainly where the tool stands for this agent, in
	// place of the event count and the install id.
	const introSubtitle =
		introState !== undefined
			? connect.isPending
				? 'Connecting…'
				: INTRO_SUBTITLES[introState]
			: undefined
	const introNeedsReconnect = introState === 'needs_reconnect' || reconnect
	const connectLabel = reconnect ? 'Reconnect' : 'Connect'

	return (
		<ProviderCard
			name={provider.displayName}
			badge={isDrive && <StatusPill tone="new">{DRIVE_COPY.providerCard.pill}</StatusPill>}
			compact={introState !== undefined}
			chat={variant === 'chat'}
			subtitle={introSubtitle ?? connectedLabel}
			tone={
				needsReconnect || (introState && introNeedsReconnect)
					? 'warning'
					: isConnected
						? 'connected'
						: 'available'
			}
			subtitleTitle={needsReconnect ? integration?.missingScopes?.join(', ') : undefined}
			status={
				isConnected
					? needsReconnect
						? { tone: 'warn', label: 'Reconnect needed' }
						: { tone: 'ok', label: 'Connected' }
					: undefined
			}
			notes={
				<>
					{isDrive && (
						<>
							<p className="text-xs text-muted-foreground">{DRIVE_COPY.providerCard.description}</p>
							<p className="text-xs text-muted-foreground">{DRIVE_COPY.providerCard.meta}</p>
						</>
					)}
					{isFreeIdentityAddon && (
						<p className="text-xs text-muted-foreground">
							Included in your enterprise plan — no per-identity charge.
						</p>
					)}
					{isPaidIdentityAddon && (
						<p className="text-xs text-muted-foreground">
							{isConnected
								? '$49/month per connected identity, billed on your Maskin subscription. Disconnecting stops the charge at the end of the current period.'
								: '$49/month per connected identity, added to your Maskin subscription.'}
						</p>
					)}
				</>
			}
			actions={
				isConnected ? (
					<div className="flex shrink-0 items-center gap-2">
						{driveDetailsLink}
						{needsReconnect && (
							<ViewerTooltip>
								<Button
									variant="outline"
									size="sm"
									className={PILL_BUTTON}
									onClick={handleConnect}
									disabled={connect.isPending || !canWrite}
								>
									Reconnect
								</Button>
							</ViewerTooltip>
						)}
						{variant === 'chat' ? (
							// The intro's row already warns and offers Reconnect; a disabled
							// "Connected" beside it would say the opposite.
							introState && needsReconnect ? null : (
								<ConnectedButton />
							)
						) : (
							<ViewerTooltip>
								<Button
									variant="ghost"
									size="sm"
									className={cn(PILL_BUTTON, 'text-muted-foreground hover:text-error')}
									onClick={() => disconnect.mutate(integration.id)}
									disabled={disconnect.isPending || !canWrite}
								>
									Disconnect
								</Button>
							</ViewerTooltip>
						)}
					</div>
				) : (
					<div className="flex shrink-0 items-center gap-2">
						{driveDetailsLink}
						{linkableCount > 0 && (
							<ViewerTooltip>
								<Button
									variant="outline"
									size="sm"
									className={PILL_BUTTON}
									onClick={onRequestLink}
									disabled={!canWrite}
								>
									<Link2 className="mr-1 h-3.5 w-3.5" />
									Add existing
								</Button>
							</ViewerTooltip>
						)}
						<ViewerTooltip>
							<Button
								size="sm"
								className={cn(
									PILL_BUTTON,
									!introState && variant === 'settings' && 'text-brand hover:text-brand-hover',
								)}
								variant={introState ? 'outline' : variant === 'settings' ? 'ghost' : undefined}
								onClick={handleConnect}
								disabled={connect.isPending || !canWrite}
								aria-label={introState ? `${connectLabel} ${provider.displayName}` : undefined}
							>
								{introState && connect.isPending ? (
									<>
										<Spinner className="mr-1" />
										Connecting…
									</>
								) : (
									connectLabel
								)}
							</Button>
						</ViewerTooltip>
					</div>
				)
			}
			footer={
				// Who can use it is managed in Settings, not from the chat card.
				isConnected && variant === 'settings' ? (
					<AgentAccess integration={integration} workspaceId={workspaceId} />
				) : undefined
			}
		/>
	)
}

export function GroupedProviderRow({
	provider,
	installations,
	workspaceId,
	linkableCount,
	onRequestLink,
	onRequestSkjaldConnect,
	returnTo,
	variant = 'settings',
}: {
	provider: ProviderInfo
	installations: IntegrationResponse[]
	workspaceId: string
	linkableCount: number
	onRequestLink: () => void
	/** Skjald connects from its own app, so "Add another" opens the how-to dialog instead of /connect. */
	onRequestSkjaldConnect?: () => void
	/** Where the connect flow should land afterwards; absent means Settings → Integrations. */
	returnTo?: string
	variant?: 'settings' | 'chat'
}) {
	const connect = useConnectIntegration(workspaceId)
	const disconnect = useDisconnectIntegration(workspaceId)
	const canWrite = useCanWrite()
	const [expanded, setExpanded] = useState(false)
	const count = installations.length

	// LinkedIn installs are per-member: the row carries `actorId`, and the only
	// human-readable identity we hold for a connected LinkedIn account is who
	// connected it — the callback stores the opaque LinkedIn account_id and
	// writes nothing to `config` (routes/integrations-linkedin-unipile.ts), so
	// there is no `owner_login` equivalent to label rows with.
	const isActorScoped = provider.name === 'linkedin-unipile'
	const { actor } = useAuth()
	const currentActorId = actor?.id
	const { data: actors } = useActors(workspaceId, { enabled: isActorScoped })
	const actorNames = new Map((actors ?? []).map((a) => [a.id, a.name]))

	// One LinkedIn account per member, so the add affordance is offered only to
	// someone who has not connected yet. For a member who already has a row it
	// would reuse and overwrite that row rather than add a sibling.
	const hasOwnInstall =
		isActorScoped && installations.some((i) => i.actorId && i.actorId === currentActorId)
	const canAdd = isActorScoped ? Boolean(currentActorId) && !hasOwnInstall : true
	const addLabel = isActorScoped ? 'Connect your account' : 'Add another'
	// Settings spells out what is being added; the chat card keeps the short "+ Add another".
	const settingsAddLabel = isActorScoped ? addLabel : 'Connect another installation'

	const unitLabel = isActorScoped ? 'connected account' : 'active installation'

	// Same $49/identity disclosure ProviderRow makes, which a workspace on its
	// second LinkedIn account would otherwise never see again.
	const { isFree: isFreeIdentityAddon, isPaid: isPaidIdentityAddon } = useIdentityAddonPricing(
		workspaceId,
		provider.name,
	)

	const addInstall = () =>
		onRequestSkjaldConnect
			? onRequestSkjaldConnect()
			: connect.mutate({ provider: provider.name, returnTo })

	// In a chat there is no expandable list to manage installs from: show that the
	// provider is connected, and offer the "+ Add another" that a single-row card
	// would otherwise have no place for. Managing or removing installs stays in
	// Settings → Integrations.
	if (variant === 'chat') {
		return (
			<ProviderCard
				name={`${provider.displayName} · ${count}`}
				subtitle={`${count} ${unitLabel}${count === 1 ? '' : 's'}`}
				tone="connected"
				chat
				notes={
					<>
						{isFreeIdentityAddon && (
							<p className="text-xs text-muted-foreground">
								Included in your enterprise plan — no per-identity charge.
							</p>
						)}
						{isPaidIdentityAddon && (
							<p className="text-xs text-muted-foreground">
								$49/month per connected identity, billed on your Maskin subscription.
							</p>
						)}
					</>
				}
				actions={
					<div className="flex shrink-0 flex-wrap items-center gap-2">
						<ConnectedButton />
						{canAdd && (
							<ViewerTooltip>
								<Button
									variant="outline"
									size="sm"
									onClick={addInstall}
									disabled={connect.isPending || !canWrite}
								>
									<Plus className="mr-1 h-3.5 w-3.5" />
									{addLabel}
								</Button>
							</ViewerTooltip>
						)}
						{linkableCount > 0 && (
							<ViewerTooltip>
								<Button
									variant="outline"
									size="sm"
									className={PILL_BUTTON}
									onClick={onRequestLink}
									disabled={!canWrite}
								>
									<Link2 className="mr-1 h-3.5 w-3.5" />
									Add existing
								</Button>
							</ViewerTooltip>
						)}
					</div>
				}
			/>
		)
	}

	return (
		<div className="overflow-hidden rounded-xl border border-border bg-card">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-bg-hover max-md:min-h-11"
			>
				<div className="flex-1 min-w-0">
					<p className="text-[15px] font-semibold text-foreground truncate">
						{provider.displayName} · {count}
					</p>
					<p className="text-[13px] text-muted-foreground truncate">
						{count} {unitLabel}
						{count === 1 ? '' : 's'}
					</p>
					{isFreeIdentityAddon && (
						<p className="text-xs text-muted-foreground">
							Included in your enterprise plan — no per-identity charge.
						</p>
					)}
					{isPaidIdentityAddon && (
						<p className="text-xs text-muted-foreground">
							$49/month per connected identity, billed on your Maskin subscription. Disconnecting
							stops the charge at the end of the current period.
						</p>
					)}
				</div>
				<ChevronDown
					className={cn(
						'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
						expanded && 'rotate-180',
					)}
					aria-hidden="true"
				/>
			</button>
			{expanded && (
				<div className="divide-y divide-border-subtle border-t border-border">
					{installations.map((installation) => (
						<NestedInstallationRow
							key={installation.id}
							integration={installation}
							actorScoped={isActorScoped}
							actorName={installation.actorId ? actorNames.get(installation.actorId) : undefined}
							isOwn={Boolean(installation.actorId && installation.actorId === currentActorId)}
							workspaceId={workspaceId}
							onDisconnect={() => disconnect.mutate(installation.id)}
							disconnecting={disconnect.isPending}
							onReconnect={() => connect.mutate({ provider: provider.name, returnTo })}
							reconnecting={connect.isPending}
						/>
					))}
					<div className="flex flex-col gap-2 px-4 py-3 md:flex-row md:flex-wrap">
						{canAdd && (
							<ViewerTooltip className="flex w-full md:w-auto">
								<Button
									variant="outline"
									size="sm"
									className={cn(PILL_BUTTON, 'w-full md:w-auto')}
									onClick={addInstall}
									disabled={connect.isPending || !canWrite}
								>
									<Plus className="h-3.5 w-3.5 mr-1" />
									{settingsAddLabel}
								</Button>
							</ViewerTooltip>
						)}
						{linkableCount > 0 && (
							<ViewerTooltip className="flex w-full md:w-auto">
								<Button
									variant="outline"
									size="sm"
									className={cn(PILL_BUTTON, 'w-full md:w-auto')}
									onClick={onRequestLink}
									disabled={!canWrite}
								>
									<Link2 className="h-3.5 w-3.5 mr-1" />
									Add existing
								</Button>
							</ViewerTooltip>
						)}
						{provider.name === 'github' && (
							<InstallGithubOrgButton workspaceId={workspaceId} returnTo={returnTo} />
						)}
					</div>
				</div>
			)}
		</div>
	)
}

function NestedInstallationRow({
	integration,
	actorScoped = false,
	actorName,
	isOwn = false,
	workspaceId,
	onDisconnect,
	disconnecting,
	onReconnect,
	reconnecting,
}: {
	integration: IntegrationResponse
	/** True for providers whose installs belong to a member, not the workspace. */
	actorScoped?: boolean
	/** Display name of the member who connected an actor-scoped install. */
	actorName?: string
	isOwn?: boolean
	workspaceId: string
	onDisconnect: () => void
	disconnecting: boolean
	/** Runs the provider's normal sign-in, which updates this row in place. */
	onReconnect: () => void
	reconnecting: boolean
}) {
	const canWrite = useCanWrite()
	// Same rule as the single row: a token that predates a scope the provider now asks for
	// keeps working for what it was granted, so the install stays listed but says so.
	const needsReconnect =
		Boolean(integration.needsReconnect) && (integration.missingScopes?.length ?? 0) > 0
	const ownerLogin =
		typeof integration.config.owner_login === 'string' ? integration.config.owner_login : undefined
	// An actor-scoped install is identified by the member who connected it —
	// the provider gives us only an opaque account id, which is meaningless to
	// read but is still the stable id worth showing underneath.
	const noun = actorScoped ? 'Account' : 'Installation'
	const label = actorScoped
		? (actorName ?? (isOwn ? 'You' : 'Workspace member'))
		: (ownerLogin ??
			(integration.externalId ? `Installation ${integration.externalId}` : 'Installation'))

	return (
		<div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
			<div className="flex-1 min-w-0 basis-40">
				<p className="text-[15px] font-semibold text-foreground truncate">
					{label}
					{actorScoped && isOwn && (
						<span className="ml-1 font-normal text-muted-foreground">(you)</span>
					)}
				</p>
				{integration.externalId && (
					<p className="text-[13px] text-muted-foreground truncate">
						{noun} {integration.externalId}
					</p>
				)}
			</div>
			<StatusPill soft tone={needsReconnect ? 'warn' : 'ok'}>
				{needsReconnect ? 'Reconnect needed' : 'Active'}
			</StatusPill>
			{needsReconnect && (
				<ViewerTooltip>
					<Button
						variant="outline"
						size="sm"
						className={cn(PILL_BUTTON, 'shrink-0')}
						onClick={onReconnect}
						disabled={reconnecting || !canWrite}
						title={integration.missingScopes?.join(', ')}
					>
						Reconnect
					</Button>
				</ViewerTooltip>
			)}
			<ViewerTooltip>
				<Button
					variant="ghost"
					size="sm"
					className={cn(PILL_BUTTON, 'shrink-0 text-muted-foreground hover:text-error')}
					onClick={onDisconnect}
					disabled={disconnecting || !canWrite}
				>
					Disconnect
				</Button>
			</ViewerTooltip>
			<div className="basis-full">
				<AgentAccess integration={integration} workspaceId={workspaceId} />
			</div>
		</div>
	)
}

/** The read-only state a chat card shows once a provider is connected. */
function ConnectedButton() {
	return (
		<Button variant="outline" size="sm" disabled>
			<Check className="mr-1 h-3.5 w-3.5" />
			Connected
		</Button>
	)
}

/**
 * One provider's whole connect experience — the row plus every dialog its flow
 * can open (API key, Skjald how-to, GitHub "add existing", Resend wizard).
 *
 * Settings → Integrations and the Connect card an agent puts in chat both render
 * this, so every provider connects the same way in both places. `returnTo` is
 * what makes the chat case land back in the chat after an OAuth round-trip.
 */
export function ProviderConnectRow({
	provider,
	installations,
	workspaceId,
	returnTo,
	variant = 'settings',
	reconnect,
	introState,
}: {
	provider: ProviderInfo
	/** This provider's active integrations in the workspace. */
	installations: IntegrationResponse[]
	workspaceId: string
	returnTo?: string
	variant?: 'settings' | 'chat'
	reconnect?: boolean
	/** The quiet row of an agent intro; see ProviderRow. */
	introState?: IntegrationToolState
}) {
	const [apiKeyOpen, setApiKeyOpen] = useState(false)
	const [apiKey, setApiKey] = useState('')
	const [skjaldOpen, setSkjaldOpen] = useState(false)
	const [linkGithubOpen, setLinkGithubOpen] = useState(false)
	const [resendOpen, setResendOpen] = useState(false)
	const [deepdotsOpen, setDeepdotsOpen] = useState(false)

	// GitHub only installs its App once per org, so a workspace that wants an org
	// someone already connected elsewhere binds to the existing installation.
	const isGithub = provider.name === 'github'
	const { data: linkable } = useLinkableGithubInstallations(workspaceId, { enabled: isGithub })
	const linkableCount = isGithub ? (linkable ?? []).filter((i) => !i.alreadyLinked).length : 0

	const openSkjald = provider.name === 'skjald' ? () => setSkjaldOpen(true) : undefined

	return (
		<>
			{/* The intro's quiet row stays one row per tool, so it never takes the install list. */}
			{MULTI_INSTALL_PROVIDERS.has(provider.name) &&
			installations.length > 0 &&
			introState === undefined ? (
				<GroupedProviderRow
					provider={provider}
					installations={installations}
					workspaceId={workspaceId}
					linkableCount={linkableCount}
					onRequestLink={() => setLinkGithubOpen(true)}
					onRequestSkjaldConnect={openSkjald}
					returnTo={returnTo}
					variant={variant}
				/>
			) : (
				<ProviderRow
					provider={provider}
					integration={installations[0]}
					workspaceId={workspaceId}
					onRequestApiKey={() => {
						setApiKey('')
						setApiKeyOpen(true)
					}}
					onRequestSkjaldConnect={openSkjald}
					onRequestResendConnect={
						provider.name === 'resend' ? () => setResendOpen(true) : undefined
					}
					onRequestDeepdotsConnect={
						provider.name === 'deepdots' ? () => setDeepdotsOpen(true) : undefined
					}
					linkableCount={linkableCount}
					onRequestLink={() => setLinkGithubOpen(true)}
					returnTo={returnTo}
					variant={variant}
					reconnect={reconnect}
					introState={introState}
				/>
			)}
			{provider.authType === 'api_key' && (
				<ApiKeyDialog
					workspaceId={workspaceId}
					provider={apiKeyOpen ? provider : null}
					apiKey={apiKey}
					onApiKeyChange={setApiKey}
					onClose={() => {
						setApiKeyOpen(false)
						setApiKey('')
					}}
					returnTo={returnTo}
				/>
			)}
			{provider.name === 'skjald' && (
				<SkjaldConnectDialog
					workspaceId={workspaceId}
					open={skjaldOpen}
					onClose={() => setSkjaldOpen(false)}
				/>
			)}
			{isGithub && (
				<LinkGithubDialog
					workspaceId={workspaceId}
					open={linkGithubOpen}
					onClose={() => setLinkGithubOpen(false)}
					returnTo={returnTo}
				/>
			)}
			{provider.name === 'deepdots' && (
				<DeepdotsConnectDialog
					workspaceId={workspaceId}
					open={deepdotsOpen}
					onClose={() => setDeepdotsOpen(false)}
				/>
			)}
			{provider.name === 'resend' && (
				<ResendConnectDialog
					workspaceId={workspaceId}
					open={resendOpen}
					prefill={null}
					onClose={() => setResendOpen(false)}
				/>
			)}
		</>
	)
}
