import {
	type AttentionItem,
	NeedsAttentionStrip,
} from '@/components/integrations/needs-attention-strip'
import {
	ProviderConnectRow,
	SLACK_HISTORY_SCOPES,
} from '@/components/integrations/provider-connect-row'
import { InstallGithubOrgSection } from '@/components/integrations/provider-dialogs'
import {
	ResendConnectDialog,
	type ResendConnectPrefill,
} from '@/components/integrations/resend/resend-connect-dialog'
import {
	ToolsSection,
	maskinRowMatches,
	matchingToolServers,
} from '@/components/integrations/tools-section'
import { SettingsPageTitle } from '@/components/settings/settings-page-title'
import { EditorBanner } from '@/components/shared/editor-banner'
import { EmptyState } from '@/components/shared/empty-state'
import { FilterTabs } from '@/components/shared/filter-tabs'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useCanWrite } from '@/hooks/use-can-write'
import {
	useConnectIntegration,
	useGithubPendingSelection,
	useIntegrations,
	useProviders,
	useSelectGithubInstallation,
} from '@/hooks/use-integrations'
import type { IntegrationResponse, ProviderInfo, ResendDnsRecord } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { INTEGRATION_CATEGORIES, logoDomainFor } from '@/lib/integration-catalog'
import {
	type IntegrationPill,
	VENDOR_PILLS,
	YOUR_INTEGRATIONS_VISIBLE,
	brokenFirst,
	groupByCategory,
	integrationNeedsReconnect,
	isFiltered,
	matchesPill,
	matchesSearch,
	newShelf,
	popularShelf,
} from '@/lib/integration-shelves'
import { PILL_BUTTON } from '@/lib/pill-button'
import { safeReturnPath } from '@/lib/return-path'
import { sortBy } from '@/lib/sort'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronDown, Plus, Search } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/integrations')({
	component: IntegrationsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	// Set by the GitHub connect callback redirecting back here: `select_github`
	// carries the pending row whose installation choices are awaiting a pick,
	// `error` reports a failed handshake, and `return_to` is the chat the connect
	// started from, so the page can send the user back once they have picked.
	validateSearch: (search: Record<string, unknown>) => ({
		select_github: typeof search.select_github === 'string' ? search.select_github : undefined,
		error: typeof search.error === 'string' ? search.error : undefined,
		return_to: typeof search.return_to === 'string' ? search.return_to : undefined,
	}),
})

/** Plain copy for the error codes the connect callback redirects here with.
 *  The raw code is never shown; anything not listed gets the generic line. */
const CONNECT_ERROR_COPY: Record<string, string> = {
	token_exchange_failed:
		"We couldn't finish connecting. The provider didn't accept the sign-in, so nothing was connected. Try again.",
	people_id_fetch_failed:
		"We couldn't read your account details from Google, so nothing was connected. Try again.",
	post_install_failed:
		'The sign-in worked, but setting up the connection failed. Try connecting again.',
	admin_approval_needed:
		"Your company's IT admin has to approve this app before you can connect. Ask them to approve it, then try again.",
}
const GENERIC_CONNECT_ERROR = "Connecting didn't work. Try again."

function IntegrationsPage() {
	const { workspaceId } = useWorkspace()
	const {
		data: integrations,
		isLoading: integrationsLoading,
		isError: integrationsError,
		refetch: refetchIntegrations,
	} = useIntegrations(workspaceId)
	const {
		data: providers,
		isLoading: providersLoading,
		isError: providersError,
		refetch: refetchProviders,
	} = useProviders()
	const visibleProviders = sortBy(
		providers ?? [],
		(p) => p.displayName,
		(p) => p.name,
	)

	// A GitHub connect where the user could reach several orgs' installations
	// comes back here with the pending row id, for them to pick one.
	const {
		select_github: selectGithubId,
		return_to: rawReturnTo,
		error: errorCode,
	} = Route.useSearch()
	const returnTo = safeReturnPath(rawReturnTo, workspaceId)
	const navigate = useNavigate({ from: Route.fullPath })
	const closeGithubSelect = () =>
		navigate({
			search: (prev) => ({ ...prev, select_github: undefined, return_to: undefined }),
			replace: true,
		})
	// A failed connect lands here with ?error=<code>. Keep the message in state and
	// drop the param, so a refresh doesn't bring the alert back.
	const [connectError, setConnectError] = useState<string | null>(null)
	useEffect(() => {
		if (!errorCode) return
		setConnectError(CONNECT_ERROR_COPY[errorCode] ?? GENERIC_CONNECT_ERROR)
		navigate({ search: (prev) => ({ ...prev, error: undefined }), replace: true })
	}, [errorCode, navigate])
	// The org is bound once picked; send the user on to the chat they started in.
	const finishGithubSelect = () => {
		if (returnTo) window.location.assign(returnTo)
		else closeGithubSelect()
	}

	const isLoading = integrationsLoading || providersLoading
	const loadFailed = !isLoading && (integrationsError || providersError)
	// Slice 2 resend dialog state — only the "Finish setup" affordance below
	// needs it at page level; a fresh Resend connect is owned by its provider row. `open` alone opens fresh at Step 1; `prefill`
	// (populated by the Resume affordance) opens straight into Step 3 with the
	// row's config.resend rehydrated.
	const [resendDialog, setResendDialog] = useState<{
		open: boolean
		prefill: ResendConnectPrefill | null
	}>({ open: false, prefill: null })

	// Group active integrations by provider — GitHub can have multiple
	// installations (one per org) and LinkedIn multiple accounts (one per
	// workspace member); other providers currently have one.
	const activeByProvider = new Map<string, IntegrationResponse[]>()
	// Rows that finished /connect but haven't posted the webhook signing secret
	// yet. Skjald reaches this state on Cancel-at-secret today; Slice 2 adds a
	// Resume affordance for the resend rows in this bucket.
	const awaitingSecretByProvider = new Map<string, IntegrationResponse[]>()
	for (const integration of integrations ?? []) {
		if (integration.status === 'active') {
			const existing = activeByProvider.get(integration.provider) ?? []
			existing.push(integration)
			activeByProvider.set(integration.provider, existing)
			continue
		}
		if (integration.status === 'awaiting_secret') {
			// Gate hiding behind the flag lives at the render call site — surfacing
			// every row here keeps the bucket tests honest.
			const existing = awaitingSecretByProvider.get(integration.provider) ?? []
			existing.push(integration)
			awaitingSecretByProvider.set(integration.provider, existing)
		}
	}
	const resendAwaitingSecret = awaitingSecretByProvider.get('resend') ?? []

	const [query, setQuery] = useState('')
	const [pill, setPill] = useState<IntegrationPill>('all')
	const [showAll, setShowAll] = useState(false)
	const [addingTool, setAddingTool] = useState(false)
	const needle = query.trim().toLowerCase()
	const filtered = isFiltered(needle, pill)
	const connect = useConnectIntegration(workspaceId)
	const canWrite = useCanWrite()
	const isHuman = getStoredActor()?.type === 'human'

	const tools = visibleProviders.filter((p) => p.name !== 'custom-mcp')
	const matching = tools.filter(
		(p) => matchesPill(p.name, pill) && matchesSearch(p.displayName, needle),
	)
	const yours = brokenFirst(
		matching.filter((p) => activeByProvider.has(p.name)),
		activeByProvider,
	)
	const availableMatching = matching.filter((p) => !activeByProvider.has(p.name))
	const connectedNames = new Set(activeByProvider.keys())
	const unconnected = tools.filter((p) => !connectedNames.has(p.name))
	const popular = popularShelf(unconnected, connectedNames)
	const fresh = newShelf(unconnected, connectedNames)
	const groups = groupByCategory(availableMatching)

	// Custom tool servers and the Maskin row sit with the connected tools. They follow the
	// search and the pill as before: only All and Custom show them.
	const showServers = pill === 'all' || pill === 'Custom'
	const serverCount = showServers ? matchingToolServers(integrations, needle).length : 0
	const showTools =
		showServers &&
		(maskinRowMatches(needle) || matchingToolServers(integrations, needle).length > 0)
	const yoursCount = yours.length + serverCount
	const collapsed = !showAll && yours.length > YOUR_INTEGRATIONS_VISIBLE
	const shownYours = collapsed ? yours.slice(0, YOUR_INTEGRATIONS_VISIBLE) : yours
	const nothingConnected = connectedNames.size === 0 && !(integrations ?? []).some(isActiveServer)
	const pillLabel = pill === 'all' ? 'All' : pill

	const attention = buildAttentionItems({
		providers: visibleProviders,
		activeByProvider,
		resendRows: resendAwaitingSecret,
		reconnect: (provider) => connect.mutate({ provider }),
		reconnecting: connect.isPending,
		finishResend: (prefill) => setResendDialog({ open: true, prefill }),
	})

	const clearFilters = () => {
		setQuery('')
		setPill('all')
	}
	const startAdding = () => {
		clearFilters()
		setShowAll(true)
		setAddingTool(true)
	}
	const noMatchCopy = needle
		? 'No integration matches that search'
		: 'No integration matches that filter'
	const nothingMatches =
		filtered && yoursCount === 0 && !showTools && availableMatching.length === 0

	// Search and pills stay pinned under the floating top bar while the page scrolls. The scroll
	// area (MainScrollArea) pads its top by the bar height plus a gap and a sticky element is held
	// inside that padding, so the offset is minus the gap: the bar then sits right under it.
	// No side bleed: a negative margin pushed the bar 8px past the page column and the page
	// scrolled sideways. On phones the chips are 44px tall.
	const pinnedBar = (
		<div className="sticky top-[calc(var(--app-header-gap,1rem)*-1)] z-10 mb-6 bg-background pt-1 pb-3">
			<div className="relative">
				<Search
					aria-hidden="true"
					className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key !== 'Escape') return
						// Text first: Esc clears it. On an empty field Esc leaves the field.
						// preventDefault so Chrome and Safari's own clear does not double up.
						if (query) {
							e.preventDefault()
							setQuery('')
						} else {
							e.currentTarget.blur()
						}
					}}
					placeholder="Search integrations and tools"
					aria-label="Search integrations and tools"
					className="h-11 rounded-xl bg-muted pl-10"
				/>
			</div>
			<FilterTabs
				variant="chip-outline"
				aria-label="Filter integrations"
				value={pill}
				onChange={setPill}
				tabs={[
					{ label: 'All', value: 'all' as IntegrationPill },
					...VENDOR_PILLS.map((v, i) => ({
						label: v,
						value: v as IntegrationPill,
						dividerBefore: i === 0,
					})),
					...INTEGRATION_CATEGORIES.map((c, i) => ({
						label: c,
						value: c as IntegrationPill,
						dividerBefore: i === 0,
					})),
				]}
				className="mt-3 max-md:flex-nowrap max-md:[&_button]:min-h-11 md:flex-wrap"
			/>
		</div>
	)

	return (
		<div className="@container max-w-[880px]">
			<div className="flex flex-wrap items-start justify-between gap-x-3">
				<div className="min-w-0 flex-1 basis-60">
					<SettingsPageTitle
						title="Integrations"
						subtitle="Connect the tools your agents work with. Everyone in this workspace shares the same connections."
					/>
				</div>
				{isHuman && (
					<ViewerTooltip>
						<Button
							size="sm"
							className={cn(PILL_BUTTON, 'mt-1 shrink-0')}
							disabled={!canWrite}
							onClick={startAdding}
						>
							<Plus className="mr-1 size-3.5" aria-hidden="true" />
							Add your own
						</Button>
					</ViewerTooltip>
				)}
			</div>
			{connectError && (
				<EditorBanner
					tone="danger"
					className="mb-3"
					actions={
						<Button size="sm" variant="ghost" onClick={() => setConnectError(null)}>
							Dismiss
						</Button>
					}
				>
					{connectError}
				</EditorBanner>
			)}
			{isLoading ? (
				<>
					{pinnedBar}
					<output className="block">
						<span className="sr-only">Loading integrations</span>
						<ListSkeleton />
					</output>
				</>
			) : loadFailed ? (
				<EmptyState
					title="Couldn't load integrations"
					description="Check your connection and try again. Your connected tools are not affected."
					action={
						<Button
							size="sm"
							variant="outline"
							className={PILL_BUTTON}
							onClick={() => {
								void refetchIntegrations?.()
								void refetchProviders?.()
							}}
						>
							Try again
						</Button>
					}
				/>
			) : !visibleProviders.length ? (
				<EmptyState
					title="No providers available"
					description="No integration providers are configured on the server"
				/>
			) : (
				<>
					{pinnedBar}
					<NeedsAttentionStrip items={attention} />
					{nothingMatches ? (
						<EmptyState
							title={noMatchCopy}
							description="Can't find the tool? Add it with a link to its server."
							action={
								<div className="flex flex-wrap justify-center gap-2">
									<Button
										size="sm"
										variant="outline"
										className={PILL_BUTTON}
										onClick={clearFilters}
									>
										{needle ? 'Clear search' : 'Clear filter'}
									</Button>
									{isHuman && (
										<Button
											size="sm"
											variant="outline"
											className={PILL_BUTTON}
											disabled={!canWrite}
											onClick={startAdding}
										>
											Add your own
										</Button>
									)}
								</div>
							}
						/>
					) : (
						<div className="space-y-8">
							{(yoursCount > 0 || showTools || !filtered) && (
								<section aria-label="Your integrations" className="space-y-3">
									<h2 className="text-lg font-semibold text-foreground">Your integrations</h2>
									{nothingConnected && !filtered && (
										<div className="rounded-2xl border border-dashed border-border p-[18px]">
											<p className="text-base font-semibold text-foreground">
												Nothing connected yet
											</p>
											<p className="text-[13px] text-muted-foreground">
												Connect a tool below so your agents can read and act in it. Email and
												calendar are a good first pair.
											</p>
										</div>
									)}
									{shownYours.map((provider) => (
										<ProviderConnectRow
											key={provider.name}
											provider={provider}
											installations={activeByProvider.get(provider.name) ?? []}
											workspaceId={workspaceId}
										/>
									))}
									{!collapsed && (
										<ToolsSection
											workspaceId={workspaceId}
											query={query}
											showServers={showServers}
											adding={addingTool}
											onAddingChange={setAddingTool}
										/>
									)}
									{yours.length > YOUR_INTEGRATIONS_VISIBLE && (
										<Button
											variant="ghost"
											size="sm"
											className={PILL_BUTTON}
											aria-expanded={!collapsed}
											onClick={() => setShowAll((v) => !v)}
										>
											{collapsed ? `Show all ${yoursCount}` : 'Show fewer'}
											<ChevronDown
												aria-hidden="true"
												className={cn(
													'ml-1 size-3.5 transition-transform',
													!collapsed && 'rotate-180',
												)}
											/>
										</Button>
									)}
								</section>
							)}
							{filtered ? (
								availableMatching.length > 0 && (
									<Shelf
										title={needle ? `Results for “${query.trim()}”` : pillLabel}
										count={availableMatching.length}
									>
										<RowGrid providers={availableMatching} workspaceId={workspaceId} showCategory />
									</Shelf>
								)
							) : (
								<>
									{popular.length > 0 && (
										<Shelf title="Popular">
											<RowGrid providers={popular} workspaceId={workspaceId} showCategory />
										</Shelf>
									)}
									{fresh.length > 0 && (
										<Shelf title="New">
											<RowGrid providers={fresh} workspaceId={workspaceId} showCategory />
										</Shelf>
									)}
									<Shelf title="All integrations">
										<div className="space-y-6">
											{groups.map((group) => (
												<div key={group.category} className="space-y-1">
													<h3 className="text-[13px] font-semibold text-muted-foreground">
														{group.category}{' '}
														<span className="tabular-nums font-medium opacity-70">
															{group.providers.length}
														</span>
													</h3>
													<RowGrid providers={group.providers} workspaceId={workspaceId} />
												</div>
											))}
										</div>
									</Shelf>
								</>
							)}
						</div>
					)}
				</>
			)}
			<SelectGithubInstallationDialog
				workspaceId={workspaceId}
				integrationId={selectGithubId ?? null}
				onClose={closeGithubSelect}
				onSelected={finishGithubSelect}
				returnTo={returnTo}
			/>
			<ResendConnectDialog
				workspaceId={workspaceId}
				open={resendDialog.open}
				prefill={resendDialog.prefill}
				onClose={() => setResendDialog({ open: false, prefill: null })}
			/>
		</div>
	)
}

/** A titled section of the long page. */
function Shelf({
	title,
	count,
	children,
}: {
	title: string
	count?: number
	children: ReactNode
}) {
	return (
		<section aria-label={title} className="space-y-2">
			<h2 className="text-lg font-semibold text-foreground">
				{title}
				{count !== undefined && (
					<span className="ml-2 text-[13px] font-medium tabular-nums text-muted-foreground">
						{count}
					</span>
				)}
			</h2>
			{children}
		</section>
	)
}

/** The compact rows of a shelf: one column, two once the page column is 620px wide. */
function RowGrid({
	providers,
	workspaceId,
	showCategory = false,
}: {
	providers: ProviderInfo[]
	workspaceId: string
	showCategory?: boolean
}) {
	return (
		<div className="grid grid-cols-1 gap-x-8 @[620px]:grid-cols-2">
			{providers.map((provider) => (
				<ProviderConnectRow
					key={provider.name}
					provider={provider}
					installations={[]}
					workspaceId={workspaceId}
					layout="row"
					showCategory={showCategory}
				/>
			))}
		</div>
	)
}

const isActiveServer = (i: IntegrationResponse) =>
	i.provider === 'custom-mcp' && i.status === 'active'

/** One line per tool the workspace has to fix: a token that needs more permissions, or a Resend setup left half done. */
function buildAttentionItems({
	providers,
	activeByProvider,
	resendRows,
	reconnect,
	reconnecting,
	finishResend,
}: {
	providers: ProviderInfo[]
	activeByProvider: Map<string, IntegrationResponse[]>
	resendRows: IntegrationResponse[]
	reconnect: (provider: string) => void
	reconnecting: boolean
	finishResend: (prefill: ResendConnectPrefill) => void
}): AttentionItem[] {
	const items: AttentionItem[] = []
	for (const provider of providers) {
		for (const integration of activeByProvider.get(provider.name) ?? []) {
			if (!integrationNeedsReconnect(integration)) continue
			const missing = integration.missingScopes ?? []
			const slackHistory =
				provider.name === 'slack' && missing.some((scope) => SLACK_HISTORY_SCOPES.includes(scope))
			items.push({
				key: integration.id,
				name: provider.displayName,
				domain: logoDomainFor(provider.name),
				line: slackHistory
					? "Slack needs to be reconnected. Agents can't read channel history until you do."
					: `${provider.displayName}: update needed. Reconnect to grant ${missing.length} new permission${missing.length === 1 ? '' : 's'}.`,
				actionLabel: 'Reconnect',
				onAction: () => reconnect(provider.name),
				pending: reconnecting,
			})
		}
	}
	const resendName = providers.find((p) => p.name === 'resend')?.displayName ?? 'Resend'
	for (const row of resendRows) {
		const prefill = extractResendPrefill(row)
		if (!prefill) continue
		items.push({
			key: row.id,
			name: resendName,
			domain: logoDomainFor('resend'),
			line: "Resend setup isn't finished. It's waiting for the webhook signing secret.",
			actionLabel: 'Finish setup',
			onAction: () => finishResend(prefill),
		})
	}
	return items
}

/** Read the `config.resend` blob off an integration row and reshape it into
 *  the prefill the dialog consumes. Returns null when the row is missing the
 *  shape Task 2's connect handler writes — a defensive guard against a
 *  half-migrated row from Slice 1 hand-connects. */
function extractResendPrefill(row: IntegrationResponse): ResendConnectPrefill | null {
	const resend = (row.config as { resend?: Record<string, unknown> } | undefined)?.resend
	if (!resend) return null
	const receiveSubdomain =
		typeof resend.receive_subdomain === 'string' ? resend.receive_subdomain : ''
	const webhookUrl = typeof resend.webhook_url === 'string' ? resend.webhook_url : ''
	const dnsRecordsRaw = Array.isArray(resend.dns_records) ? resend.dns_records : []
	const dnsRecords = dnsRecordsRaw.filter(
		(r): r is ResendDnsRecord =>
			typeof r === 'object' && r !== null && 'record' in r && 'status' in r,
	)
	const verificationStatus =
		resend.verification_status === 'verified' || resend.verification_status === 'failed'
			? resend.verification_status
			: 'pending'
	const capabilities =
		typeof resend.capabilities === 'object' && resend.capabilities !== null
			? (resend.capabilities as { sending?: string; receiving?: string })
			: undefined
	if (!webhookUrl || !receiveSubdomain) return null
	return {
		integrationId: row.id,
		webhookUrl,
		dnsRecords,
		verificationStatus,
		receiveSubdomain,
		capabilities,
	}
}

/** Finalizes a GitHub connect where the authorizing user could reach more than
 *  one installation. The candidates come from GitHub's own answer to "which
 *  installations can this user access", so anything listed here is already
 *  authorized — picking one just says which org this workspace meant. */
function SelectGithubInstallationDialog({
	workspaceId,
	integrationId,
	onClose,
	onSelected,
	returnTo,
}: {
	workspaceId: string
	integrationId: string | null
	onClose: () => void
	/** Runs after an org is picked — navigates on to `returnTo` when there is one. */
	onSelected: () => void
	returnTo?: string
}) {
	const { data, isLoading } = useGithubPendingSelection(workspaceId, integrationId)
	const select = useSelectGithubInstallation(workspaceId)
	const canWrite = useCanWrite()
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
											{ onSuccess: onSelected },
										)
									}
									disabled={select.isPending || !canWrite}
								>
									Connect
								</Button>
							</div>
						))}
					</div>
				)}
				<InstallGithubOrgSection workspaceId={workspaceId} returnTo={returnTo} />
				<div className="flex justify-end">
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
