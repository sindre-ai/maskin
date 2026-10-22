import { ProviderConnectRow } from '@/components/integrations/provider-connect-row'
import { InstallGithubOrgSection } from '@/components/integrations/provider-dialogs'
import {
	ResendConnectDialog,
	type ResendConnectPrefill,
} from '@/components/integrations/resend/resend-connect-dialog'
import { ToolsSection } from '@/components/integrations/tools-section'
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
import {
	useGithubPendingSelection,
	useIntegrations,
	useProviders,
	useSelectGithubInstallation,
} from '@/hooks/use-integrations'
import type { IntegrationResponse, ResendDnsRecord } from '@/lib/api'
import { safeReturnPath } from '@/lib/return-path'
import { sortBy } from '@/lib/sort'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

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

function IntegrationsPage() {
	const { workspaceId } = useWorkspace()
	const { data: integrations, isLoading: integrationsLoading } = useIntegrations(workspaceId)
	const { data: providers, isLoading: providersLoading } = useProviders()
	const visibleProviders = sortBy(
		providers ?? [],
		(p) => p.displayName,
		(p) => p.name,
	)

	// A GitHub connect where the user could reach several orgs' installations
	// comes back here with the pending row id, for them to pick one.
	const { select_github: selectGithubId, return_to: rawReturnTo } = Route.useSearch()
	const returnTo = safeReturnPath(rawReturnTo, workspaceId)
	const navigate = useNavigate({ from: Route.fullPath })
	const closeGithubSelect = () =>
		navigate({
			search: (prev) => ({ ...prev, select_github: undefined, return_to: undefined }),
			replace: true,
		})
	// The org is bound once picked; send the user on to the chat they started in.
	const finishGithubSelect = () => {
		if (returnTo) window.location.assign(returnTo)
		else closeGithubSelect()
	}

	const isLoading = integrationsLoading || providersLoading
	// Slice 2 resend dialog state — only the "Resume connect" affordance below
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

	return (
		<div>
			{isLoading ? (
				<ListSkeleton />
			) : !visibleProviders.length ? (
				<EmptyState
					title="No providers available"
					description="No integration providers are configured on the server"
				/>
			) : (
				<div className="space-y-2">
					{visibleProviders.map((provider) => (
						<ProviderConnectRow
							key={provider.name}
							provider={provider}
							installations={activeByProvider.get(provider.name) ?? []}
							workspaceId={workspaceId}
						/>
					))}
					{resendAwaitingSecret.length > 0 && (
						<ResendResumeSection
							rows={resendAwaitingSecret}
							onResume={(prefill) => setResendDialog({ open: true, prefill })}
						/>
					)}
				</div>
			)}
			<ToolsSection workspaceId={workspaceId} />
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

/** Renders the row(s) whose resend row is stuck at `awaiting_secret` — usually
 *  one, because a workspace has one resend row. Each carries a Resume connect
 *  affordance that reopens the dialog directly at Step 3 with the row's
 *  `config.resend` blob rehydrated. */
function ResendResumeSection({
	rows,
	onResume,
}: {
	rows: IntegrationResponse[]
	onResume: (prefill: ResendConnectPrefill) => void
}) {
	return (
		<div className="space-y-2">
			<p className="text-[8px] font-bold tracking-[0.11em] uppercase text-muted-foreground font-mono pt-2">
				CONNECTIONS AWAITING A SECRET
			</p>
			{rows.map((row) => {
				const prefill = extractResendPrefill(row)
				if (!prefill) return null
				return (
					<div
						key={row.id}
						className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/5 p-4"
					>
						<div className="h-3 w-3 shrink-0 rounded-full bg-warning" aria-hidden="true" />
						<div className="flex-1 min-w-0">
							<p className="text-sm font-medium text-foreground truncate">
								Resend — {prefill.receiveSubdomain}
							</p>
							<p className="text-xs text-muted-foreground truncate">
								Awaiting the whsec_… secret. Pick up where you left off in Step 3.
							</p>
						</div>
						<Button size="sm" onClick={() => onResume(prefill)}>
							Resume connect
						</Button>
					</div>
				)
			})}
		</div>
	)
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
									disabled={select.isPending}
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
