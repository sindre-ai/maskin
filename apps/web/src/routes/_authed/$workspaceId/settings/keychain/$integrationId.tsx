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
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { RouteError } from '@/components/shared/route-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useCredentialAuditLog, useIntegrations } from '@/hooks/use-integrations'
import type { CredentialAuditEntry } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

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
							<span className="font-mono text-xs text-muted-foreground">
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
	}
}

function CredentialDetailPage() {
	const { integrationId } = Route.useParams()
	const { workspaceId } = useWorkspace()
	const { data: integrations, isLoading } = useIntegrations(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const audit = useCredentialAuditLog(workspaceId, integrationId)
	const credential = integrations?.find((i) => i.id === integrationId)
	useDocumentTitle(credential ? credentialName(credential) : 'Keychain')

	const actorName = (actorId: string) => actors?.find((a) => a.id === actorId)?.name
	const entries = audit.data?.pages.flatMap((page) => page.entries) ?? []

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
				</section>
			</div>
		</div>
	)
}
