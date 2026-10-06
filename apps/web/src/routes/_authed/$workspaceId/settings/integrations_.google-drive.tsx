import { DisconnectDriveModal } from '@/components/integrations/drive/disconnect-modal'
import { FolderWatches } from '@/components/integrations/drive/folder-watches'
import { McpTag } from '@/components/integrations/drive/mcp-tag'
import { ScopeDriftBanner } from '@/components/integrations/drive/scope-drift-banner'
import { ScopeChip, ScopeRow } from '@/components/integrations/drive/scope-row'
import { StatusPill, type StatusPillTone } from '@/components/integrations/drive/status-pill'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import {
	useConnectIntegration,
	useDisconnectGoogle,
	useIntegrations,
} from '@/hooks/use-integrations'
import { DRIVE_COPY } from '@/lib/drive-copy'
import {
	type DriveDisconnectScope,
	connectedGoogleProviders,
	remainingProviders,
} from '@/lib/drive-disconnect'
import { DRIVE_DISCONNECT_COPY } from '@/lib/drive-disconnect-copy'
import {
	DRIVE_PROVIDER,
	DRIVE_SCOPES,
	type DriveDetailVariant,
	type DriveHuman,
	deriveDriveHumans,
	pickDriveVariant,
} from '@/lib/drive-humans'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/integrations_/google-drive')({
	component: DriveDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function DriveDetailPage() {
	// One boundary for the whole Drive surface: with the flag off nothing below
	// renders and no query fires.
	const enabled = useFeatureFlag('google-drive-integration-ui')
	if (!enabled) {
		return (
			<EmptyState
				title={DRIVE_COPY.flagOffTitle}
				description={DRIVE_COPY.flagOffDescription}
				action={<BackToIntegrations />}
			/>
		)
	}
	return <DriveDetail />
}

function BackToIntegrations() {
	const { workspaceId } = useWorkspace()
	return (
		<Button asChild variant="ghost" size="sm">
			<Link
				to="/$workspaceId/settings/integrations"
				params={{ workspaceId }}
				search={{ select_github: undefined, error: undefined }}
			>
				<ChevronLeft aria-hidden="true" />
				Integrations
			</Link>
		</Button>
	)
}

const PILL_BY_VARIANT: Record<DriveDetailVariant, { tone: StatusPillTone; label: string }> = {
	connected: { tone: 'ok', label: DRIVE_COPY.statusPill.connected },
	'scope-add': { tone: 'warn', label: DRIVE_COPY.statusPill.partial },
	'needs-reconnect': { tone: 'warn', label: DRIVE_COPY.statusPill.attention },
	'all-disconnected': { tone: 'err', label: DRIVE_COPY.statusPill.attention },
}

function DriveDetail() {
	const { workspaceId } = useWorkspace()
	const { data: integrations, isLoading } = useIntegrations(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const connect = useConnectIntegration(workspaceId)
	const startConnect = () => connect.mutate({ provider: DRIVE_PROVIDER })
	const disconnect = useDisconnectGoogle(workspaceId)
	const [target, setTarget] = useState<{ email: string; name: string } | null>(null)
	const [done, setDone] = useState<{
		email: string
		name: string
		scope: DriveDisconnectScope
	} | null>(null)

	if (isLoading || !integrations) {
		return (
			<div data-testid="drive-detail-loading">
				<ListSkeleton />
			</div>
		)
	}

	const actorNames = new Map((actors ?? []).map((a) => [a.id, a.name]))
	const humans = deriveDriveHumans(integrations)
	const variant = pickDriveVariant(humans)
	const pill = PILL_BY_VARIANT[variant]
	const displayName = (h: DriveHuman) =>
		(h.actorId ? actorNames.get(h.actorId) : undefined) ?? h.email.split('@')[0] ?? h.email

	const needAdd = humans.filter((h) => h.state === 'add-drive')
	const needReconnect = humans.filter((h) => h.state === 'needs-reconnect')
	const withDrive = humans.length - needAdd.length
	const names = (list: DriveHuman[]) => list.map(displayName).join(', ')

	return (
		<div className="space-y-4" data-testid="drive-detail" data-variant={variant}>
			<BackToIntegrations />
			<div className="flex items-start gap-3">
				<img
					src="/integrations/google-drive.svg"
					alt=""
					aria-hidden="true"
					className="h-12 w-12 rounded-md"
				/>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h2 className="text-lg font-semibold text-foreground">{DRIVE_COPY.pageTitle}</h2>
						<StatusPill tone={pill.tone}>{pill.label}</StatusPill>
					</div>
					{variant !== 'all-disconnected' && (
						<p className="text-sm text-muted-foreground" data-testid="drive-mline">
							{variant === 'connected'
								? DRIVE_COPY.connectedMline(humans.length)
								: variant === 'needs-reconnect'
									? DRIVE_COPY.needsReconnectMline(humans.length, needReconnect.length)
									: DRIVE_COPY.scopeAddMline(humans.length, withDrive, needAdd.length)}
						</p>
					)}
				</div>
			</div>

			<p className="text-sm text-muted-foreground">{DRIVE_COPY.pageDescription}</p>

			{done && (
				<output
					className="block rounded-md border border-success/40 bg-success/10 p-3 text-sm text-foreground"
					aria-live="polite"
					data-testid="post-disconnect-callout"
				>
					{DRIVE_DISCONNECT_COPY.callout(
						done.scope,
						done.name,
						remainingProviders(connectedGoogleProviders(integrations, done.email), done.scope),
					)}
				</output>
			)}

			{variant === 'all-disconnected' ? (
				<EmptyState
					title={DRIVE_COPY.emptyTitle}
					description={DRIVE_COPY.emptyDescription}
					action={
						<Button size="sm" onClick={startConnect} disabled={connect.isPending}>
							{DRIVE_COPY.emptyCta}
						</Button>
					}
				/>
			) : (
				<>
					{variant === 'scope-add' && (
						<ScopeDriftBanner
							title={DRIVE_COPY.scopeAddBannerTitle(needAdd.length)}
							body={DRIVE_COPY.scopeAddBannerBody(names(needAdd))}
							ctaLabel={DRIVE_COPY.scopeAddBannerCta}
							onCta={startConnect}
							ctaPending={connect.isPending}
							testId="scope-add-banner"
						/>
					)}
					{variant === 'needs-reconnect' && (
						<ScopeDriftBanner
							title={DRIVE_COPY.reconnectBannerTitle}
							body={DRIVE_COPY.reconnectBannerBody(names(needReconnect))}
							ctaLabel={DRIVE_COPY.reconnectBannerCta}
							onCta={startConnect}
							ctaPending={connect.isPending}
							testId="reconnect-banner"
						/>
					)}
					<ul
						className="space-y-2"
						aria-label="Google Drive status per human"
						data-testid="scope-list"
					>
						{humans.map((human) => (
							<ScopeRow
								key={human.email}
								id={human.email}
								name={displayName(human)}
								email={human.email}
								needsAttention={human.state !== 'connected'}
								actionLabel={
									human.state === 'add-drive'
										? DRIVE_COPY.humanCta
										: human.state === 'needs-reconnect'
											? DRIVE_COPY.humanReconnectCta
											: undefined
								}
								onAction={startConnect}
								actionPending={connect.isPending}
								disconnectLabel={
									human.driveIntegrationId ? DRIVE_DISCONNECT_COPY.disconnectCta : undefined
								}
								onDisconnect={() => {
									disconnect.reset()
									setDone(null)
									setTarget({ email: human.email, name: displayName(human) })
								}}
							>
								{DRIVE_SCOPES.map((s) => (
									<ScopeChip
										key={s.scope}
										label={s.label}
										sublabel={s.sublabel}
										state={human.grantedScopes.includes(s.scope) ? 'granted' : 'missing'}
									/>
								))}
							</ScopeRow>
						))}
					</ul>
					<div
						className="rounded-md border border-border bg-bg-surface p-3 text-xs text-muted-foreground"
						data-testid="callout"
					>
						<strong className="font-medium text-foreground">{DRIVE_COPY.calloutLead}</strong>
						{DRIVE_COPY.calloutBody}
					</div>
					<FolderWatches
						nameForAccount={(account) => {
							const human = humans.find((h) => h.email === account.toLowerCase())
							return human ? displayName(human) : (account.split('@')[0] ?? account)
						}}
					/>
				</>
			)}
			{target && (
				<DisconnectDriveModal
					name={target.name}
					connected={connectedGoogleProviders(integrations, target.email)}
					pending={disconnect.isPending}
					failed={disconnect.isError}
					onCancel={() => setTarget(null)}
					onConfirm={(scope) =>
						disconnect.mutate(
							{ email: target.email, scope },
							{
								onSuccess: () => {
									setDone({ email: target.email, name: target.name, scope })
									setTarget(null)
								},
							},
						)
					}
				/>
			)}
		</div>
	)
}
