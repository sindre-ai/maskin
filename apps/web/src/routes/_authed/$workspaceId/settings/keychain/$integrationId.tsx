import {
	CapturedViaChatBadge,
	CredentialStatusBadge,
	KeychainBreadcrumb,
	credentialName,
	credentialTypeLabel,
	describeScope,
	isKeychainCredential,
	providerLabel,
} from '@/components/keychain/keychain-parts'
import {
	NO_AGENT_LINE,
	ScopeEditorSheet,
	agentCountLine,
	countAgents,
	scopeSaveErrorMessage,
} from '@/components/keychain/scope-editor-sheet'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { RouteError } from '@/components/shared/route-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useDocumentTitle } from '@/hooks/use-document-title'
import {
	useCredentialAuditLog,
	useIntegrations,
	useUpdateKeyScope,
} from '@/hooks/use-integrations'
import type { CredentialAuditEntry } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/keychain/$integrationId')({
	component: CredentialDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const ACTION_LABELS: Record<CredentialAuditEntry['action'], string> = {
	read: 'READ',
	create: 'CREATE',
	undone: 'UNDONE',
	rotated: 'ROTATED',
	sweeper_activated: 'ACTIVATED',
	scope_changed: 'SCOPE CHANGED',
	tier_changed: 'TIER CHANGED',
	grant_requested: 'GRANT REQUESTED',
	grant_approved: 'GRANT APPROVED',
	grant_denied: 'GRANT DENIED',
	grant_expired: 'GRANT EXPIRED',
	grant_revoked: 'GRANT REVOKED',
}

// A tolerant read of the tier in the detail text. Anything but tier=1|2|3 gives null,
// and no other part of the text is ever shown.
function tierFromDetail(detail: string | null | undefined): 1 | 2 | 3 | null {
	const match = detail?.match(/(?:^|;)tier=([123])(?:;|$)/)
	return match ? (Number(match[1]) as 1 | 2 | 3) : null
}

function sessionLabel(sessionId: string): string {
	return `session ${sessionId.slice(0, 8)}`
}

function AuditEntryText({
	entry,
	actorName,
}: {
	entry: CredentialAuditEntry
	actorName: string
}) {
	const session = entry.sessionId ? (
		<span className="font-mono text-xs">{sessionLabel(entry.sessionId)}</span>
	) : null
	switch (entry.action) {
		case 'create':
			return entry.source === 'chat_capture' ? (
				<>
					<span aria-hidden>💬</span> <b>Captured via chat</b>
					{session && <> in {session}</>} — vaulted, redacted from transcript.
				</>
			) : (
				<>{actorName} added this credential.</>
			)
		case 'read':
			return (
				<>
					{actorName} read this credential
					{session && <> for {session}</>}
					{entry.outboundTarget && (
						<>
							{' '}
							targeting{' '}
							<span className="break-all font-mono text-xs text-muted-foreground">
								{entry.outboundTarget}
							</span>
						</>
					)}
					.
				</>
			)
		case 'undone':
			return <>{actorName} undid this capture. The key is removed.</>
		case 'rotated':
			return <>{actorName} rotated this credential.</>
		case 'sweeper_activated':
			return <>The undo window closed. This credential is now permanent.</>
		case 'scope_changed':
			return <>{actorName} changed which agents can use this credential.</>
		case 'tier_changed': {
			const tier = tierFromDetail(entry.detail)
			return <>Tier changed{tier !== null && <> to {tier}</>}</>
		}
		case 'grant_requested':
			return <>Access to this credential was requested.</>
		case 'grant_approved':
			return <>Access to this credential was approved.</>
		case 'grant_denied':
			return <>Access to this credential was denied.</>
		case 'grant_expired':
			return <>An access grant for this credential expired.</>
		case 'grant_revoked':
			return <>An access grant for this credential was revoked.</>
	}
}

function CredentialDetailPage() {
	const { integrationId } = Route.useParams()
	const { workspace, workspaceId } = useWorkspace()
	const { data: integrations, isLoading } = useIntegrations(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const audit = useCredentialAuditLog(workspaceId, integrationId)
	const updateScope = useUpdateKeyScope(workspaceId, integrationId)
	const [editingAccess, setEditingAccess] = useState(false)
	const credential = integrations?.find((i) => i.id === integrationId)
	useDocumentTitle(credential ? credentialName(credential) : 'Keychain')

	const actorName = (actorId: string) => actors?.find((a) => a.id === actorId)?.name
	const entries = audit.data?.pages.flatMap((page) => page.entries) ?? []
	// A credential always has its own created row, so "no reads" means no read row, not no rows.
	const noReads =
		!audit.isLoading &&
		!audit.isError &&
		!audit.hasNextPage &&
		!entries.some((entry) => entry.action === 'read')

	if (isLoading) {
		return (
			<div className="max-w-[880px]">
				<ListSkeleton />
			</div>
		)
	}
	if (!credential || !isKeychainCredential(credential)) {
		return (
			<div className="max-w-[880px]">
				<KeychainBreadcrumb workspaceId={workspaceId} current="Not found" />
				<EmptyState title="Credential not found" />
			</div>
		)
	}

	const name = credentialName(credential)
	const viaChat = credential.source === 'chat_capture'
	// Only an active saved API key has agents to assign. A key still in its undo window is
	// scoped by the chat card; OAuth connections keep their workspace grant.
	const assignable = credential.providerMode === 'byo_apikey' && credential.status === 'active'
	const me = getStoredActor()
	const canEditAccess =
		assignable &&
		me?.type === 'human' &&
		(credential.createdBy === me.id || workspace.role === 'owner' || workspace.role === 'admin')
	const agents = (actors ?? []).filter((a) => a.type === 'agent')
	const grants = credential.scopeGrants ?? []
	const everyAgent = grants.some((g) => g.kind === 'workspace')
	const grantedAgents = agents.filter((a) =>
		grants.some((g) => g.kind === 'actor' && g.actorId === a.id),
	)
	const agentCount = countAgents(grants, agents)

	return (
		<div className="max-w-[880px]">
			<KeychainBreadcrumb workspaceId={workspaceId} current={name} />
			<div className="mb-4 min-w-0">
				<h2 className="truncate text-base font-bold text-foreground">{name}</h2>
				<div className="mt-1.5 flex flex-wrap gap-1.5">
					<CredentialStatusBadge integration={credential} />
					<Badge variant="outline">{credentialTypeLabel(credential.providerMode)}</Badge>
					{viaChat && (
						<CapturedViaChatBadge>
							Captured via chat · <RelativeTime date={credential.createdAt} />
						</CapturedViaChatBadge>
					)}
				</div>
			</div>

			<div className="grid gap-4 md:grid-cols-[1fr_240px]">
				<section
					aria-labelledby="audit-log-heading"
					className="min-w-0 rounded-lg border border-border"
				>
					<div className="border-b border-border p-3">
						<h3 id="audit-log-heading" className="text-sm font-semibold">
							Audit log
						</h3>
						<p className="text-xs text-muted-foreground">
							Every read of this credential, chronological. SOC 2 evidence.
						</p>
					</div>
					{audit.isLoading ? (
						<div className="p-3">
							<ListSkeleton rows={3} />
						</div>
					) : audit.isError ? (
						<p className="p-3 text-sm text-error" role="alert">
							Could not load the audit log.
						</p>
					) : (
						<ul className="divide-y divide-border">
							{entries.map((entry) => (
								<li
									key={entry.id}
									className="grid grid-cols-[auto_1fr_auto] items-center gap-3 p-3"
								>
									<RelativeTime
										date={entry.readAt}
										format="clock"
										className="whitespace-nowrap font-mono text-xs text-muted-foreground"
									/>
									<div className="min-w-0 text-sm">
										<AuditEntryText
											entry={entry}
											actorName={actorName(entry.actorId) ?? 'A member'}
										/>
									</div>
									<Badge variant="outline">{ACTION_LABELS[entry.action]}</Badge>
								</li>
							))}
						</ul>
					)}
					{noReads && (
						<div className={cn('p-3', entries.length > 0 && 'border-t border-border')}>
							<p className="text-sm font-medium">No reads yet</p>
							<p className="text-xs text-muted-foreground">
								When an agent uses this credential, the read shows up here.
							</p>
						</div>
					)}
					{audit.hasNextPage && (
						<div className="border-t border-border p-2 text-center">
							<Button
								variant="ghost"
								size="sm"
								disabled={audit.isFetchingNextPage}
								onClick={() => audit.fetchNextPage()}
							>
								{audit.isFetchingNextPage ? 'Loading…' : 'Load more entries'}
							</Button>
						</div>
					)}
				</section>

				<section
					aria-labelledby="details-heading"
					className="h-fit rounded-lg border border-border p-3"
				>
					<h3 id="details-heading" className="mb-3 text-sm font-semibold">
						Details
					</h3>
					<dl className="space-y-2 text-sm">
						<div className="flex justify-between gap-3">
							<dt className="text-muted-foreground">Service</dt>
							<dd>{providerLabel(credential.provider)}</dd>
						</div>
						<div className="flex justify-between gap-3">
							<dt className="text-muted-foreground">Type</dt>
							<dd>{credentialTypeLabel(credential.providerMode)}</dd>
						</div>
						<div className="flex justify-between gap-3">
							<dt className="text-muted-foreground">Created</dt>
							<dd className="text-right">
								<RelativeTime date={credential.createdAt} />
								{viaChat && ' · via chat'}
							</dd>
						</div>
						<div className="flex justify-between gap-3">
							<dt className="text-muted-foreground">Scope</dt>
							<dd className="text-right">{describeScope(credential.scopeGrants, actorName)}</dd>
						</div>
					</dl>
					{assignable && (
						<div className="mt-3 border-t border-border pt-3">
							<div className="flex items-center justify-between gap-2">
								<h4 className="text-sm font-semibold">Agents</h4>
								{canEditAccess && (
									<Button variant="outline" size="sm" onClick={() => setEditingAccess(true)}>
										Edit access
									</Button>
								)}
							</div>
							{agentCount === 0 ? (
								<p className="mt-1.5 text-xs text-muted-foreground">{NO_AGENT_LINE}</p>
							) : (
								<>
									<p className="mt-1.5 text-xs text-muted-foreground">
										{agentCountLine(agentCount)}
									</p>
									<ul className="mt-1.5 space-y-1 text-sm">
										{everyAgent ? (
											<li>All agents in this workspace</li>
										) : (
											grantedAgents.map((agent) => (
												<li key={agent.id} className="truncate">
													{agent.name}
												</li>
											))
										)}
									</ul>
								</>
							)}
						</div>
					)}
				</section>
			</div>

			{canEditAccess && (
				<ScopeEditorSheet
					open={editingAccess}
					onOpenChange={(open) => {
						setEditingAccess(open)
						if (!open) updateScope.reset()
					}}
					credentialName={name}
					agents={agents.map((a) => ({ id: a.id, name: a.name }))}
					grants={grants}
					saving={updateScope.isPending}
					error={updateScope.isError ? scopeSaveErrorMessage(updateScope.error) : null}
					onSave={(next) =>
						updateScope.mutate(next, {
							onSuccess: () => setEditingAccess(false),
						})
					}
				/>
			)}
		</div>
	)
}
