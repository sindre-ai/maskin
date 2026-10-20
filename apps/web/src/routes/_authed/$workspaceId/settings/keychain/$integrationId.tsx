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
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { useActors } from '@/hooks/use-actors'
import { useDocumentTitle } from '@/hooks/use-document-title'
import {
	useCredentialAuditLog,
	useIntegrations,
	useRemoveCredential,
	useUpdateKeyScope,
} from '@/hooks/use-integrations'
import type { CredentialAuditEntry } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
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
			return <>{actorName} removed this credential. The secret is destroyed.</>
		case 'rotated':
			return <>{actorName} rotated this credential.</>
		case 'sweeper_activated':
			return <>The undo window closed. This credential is now permanent.</>
		case 'scope_changed':
			return <>{actorName} changed which agents can use this credential.</>
	}
}

function CredentialDetailPage() {
	const { integrationId } = Route.useParams()
	const { workspace, workspaceId } = useWorkspace()
	const { data: integrations, isLoading } = useIntegrations(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const audit = useCredentialAuditLog(workspaceId, integrationId)
	const updateScope = useUpdateKeyScope(workspaceId, integrationId)
	const removeCredential = useRemoveCredential(workspaceId)
	const navigate = useNavigate()
	const [editingAccess, setEditingAccess] = useState(false)
	const [confirmingRemove, setConfirmingRemove] = useState(false)
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
	// Only an active saved API key or login has agents to assign. One still in its undo window
	// is scoped by the chat card; OAuth connections keep their workspace grant.
	const assignable =
		(credential.providerMode === 'byo_apikey' || credential.providerMode === 'byo_login') &&
		credential.status === 'active'
	const me = getStoredActor()
	const canEditAccess =
		assignable &&
		me?.type === 'human' &&
		(credential.createdBy === me.id || workspace.role === 'owner' || workspace.role === 'admin')
	// A saved key or login can be removed at any time, by whoever saved it or a workspace
	// admin or owner: the secret is destroyed, not hidden. OAuth connections are
	// disconnected on the Integrations page instead.
	const canRemove =
		(credential.providerMode === 'byo_apikey' || credential.providerMode === 'byo_login') &&
		(credential.status === 'active' || credential.status === 'pending_undo') &&
		me?.type === 'human' &&
		(credential.createdBy === me.id || workspace.role === 'owner' || workspace.role === 'admin')
	const agents = (actors ?? []).filter((a) => a.type === 'agent')
	const grants = credential.agentGrants ?? []
	const grantedIds = grants.map((g) => g.actorId)
	const grantedAgents = agents.filter((a) => grantedIds.includes(a.id))
	const agentCount = countAgents(grantedIds, agents)
	// Agents that were allowed in single chats, and not by a grant: they can use it there too.
	const chatShared = agents
		.filter((a) => !grantedIds.includes(a.id))
		.map((a) => ({
			agent: a,
			chats: (credential.chatGrants ?? []).filter((g) => g.actorId === a.id).length,
		}))
		.filter((x) => x.chats > 0)

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
							<dd className="text-right">{describeScope(credential.agentGrants, actorName)}</dd>
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
							{chatShared.length > 0 && (
								<div className="mt-1.5">
									<p className="text-xs text-muted-foreground">Also allowed in single chats</p>
									<ul className="mt-1 space-y-1 text-sm">
										{chatShared.map(({ agent, chats }) => (
											<li key={agent.id} className="truncate">
												{agent.name} · {chats} {chats === 1 ? 'chat' : 'chats'}
											</li>
										))}
									</ul>
								</div>
							)}
							{agentCount === 0 ? (
								<p className="mt-1.5 text-xs text-muted-foreground">{NO_AGENT_LINE}</p>
							) : (
								<>
									<p className="mt-1.5 text-xs text-muted-foreground">
										{agentCountLine(agentCount)}
									</p>
									<ul className="mt-1.5 space-y-1 text-sm">
										{grantedAgents.map((agent) => (
											<li key={agent.id} className="truncate">
												{agent.name}
											</li>
										))}
									</ul>
								</>
							)}
						</div>
					)}
					{canRemove && (
						<div className="mt-3 border-t border-border pt-3">
							<Button
								variant="outline"
								size="sm"
								className="w-full"
								onClick={() => {
									removeCredential.reset()
									setConfirmingRemove(true)
								}}
							>
								Remove credential
							</Button>
						</div>
					)}
				</section>
			</div>

			{canRemove && (
				<ResponsiveDialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
					<ResponsiveDialogContent>
						<ResponsiveDialogHeader>
							<ResponsiveDialogTitle>Remove {name}?</ResponsiveDialogTitle>
							<ResponsiveDialogDescription>
								The secret is destroyed and can't be recovered. Agents that use it can no longer
								start with it, and an agent that is running now keeps it until its session ends. You
								can add it again at any time.
							</ResponsiveDialogDescription>
						</ResponsiveDialogHeader>
						{removeCredential.isError && (
							<p className="text-sm text-error" role="alert">
								Could not remove this credential. Try again.
							</p>
						)}
						<ResponsiveDialogFooter>
							<Button variant="ghost" onClick={() => setConfirmingRemove(false)}>
								Cancel
							</Button>
							<Button
								variant="destructive"
								disabled={removeCredential.isPending}
								onClick={() =>
									removeCredential.mutate(integrationId, {
										onSuccess: () => {
											setConfirmingRemove(false)
											navigate({
												to: '/$workspaceId/settings/keychain',
												params: { workspaceId },
											})
										},
									})
								}
							>
								{removeCredential.isPending ? 'Removing…' : 'Remove'}
							</Button>
						</ResponsiveDialogFooter>
					</ResponsiveDialogContent>
				</ResponsiveDialog>
			)}

			{canEditAccess && (
				<ScopeEditorSheet
					open={editingAccess}
					onOpenChange={(open) => {
						setEditingAccess(open)
						if (!open) updateScope.reset()
					}}
					credentialName={name}
					agents={agents.map((a) => ({ id: a.id, name: a.name }))}
					grantedIds={grantedIds}
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
