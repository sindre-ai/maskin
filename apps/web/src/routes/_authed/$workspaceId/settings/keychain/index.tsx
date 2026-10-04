import {
	CapturedViaChatBadge,
	CredentialStatusBadge,
	credentialName,
	credentialTypeLabel,
	describeScope,
	isKeychainCredential,
} from '@/components/keychain/keychain-parts'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { RouteError } from '@/components/shared/route-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useIntegrations } from '@/hooks/use-integrations'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Plus } from 'lucide-react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/keychain/')({
	component: KeychainPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const INTRO =
	'Credentials your agents use to reach external services. Each key is encrypted at rest, assigned to specific agents or loops, and every use is logged.'

function AddCredentialButton({ workspaceId, label }: { workspaceId: string; label: string }) {
	return (
		<Button asChild size="sm">
			<Link to="/$workspaceId/settings/keychain/new" params={{ workspaceId }}>
				<Plus size={14} className="mr-1" />
				{label}
			</Link>
		</Button>
	)
}

function KeychainPage() {
	useDocumentTitle('Keychain')
	const { workspaceId } = useWorkspace()
	const { data: integrations, isLoading } = useIntegrations(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const actorName = (actorId: string) => actors?.find((a) => a.id === actorId)?.name

	const credentials = (integrations ?? [])
		.filter(isKeychainCredential)
		.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
	const hasChatCaptured = credentials.some((c) => c.source === 'chat_capture')

	return (
		<div className="max-w-[720px]">
			<div className="mb-3 flex flex-wrap items-start gap-2">
				<div className="min-w-0 flex-1 basis-64">
					<h2 className="text-sm font-bold text-foreground">Keychain</h2>
					<p className="mt-1 text-xs text-muted-foreground">{INTRO}</p>
				</div>
				{credentials.length > 0 && (
					<AddCredentialButton workspaceId={workspaceId} label="Add credential" />
				)}
			</div>

			{isLoading ? (
				<ListSkeleton />
			) : credentials.length === 0 ? (
				<div className="flex flex-col items-center rounded-lg border border-border px-4 py-10 text-center">
					<div className="text-4xl" aria-hidden>
						🔑
					</div>
					<h3 className="mt-3 text-[17px] font-bold text-foreground">
						One place for every credential your agents need
					</h3>
					<p className="mt-1.5 max-w-[48ch] text-[12.5px] leading-relaxed text-muted-foreground">
						Paste an API key, connect a service with OAuth, or just drop the key into a chat —
						Maskin will vault it, redact it from the transcript, and ask you which agents can use
						it. Encrypted, scoped, and logged.
					</p>
					<div className="mt-4">
						<AddCredentialButton workspaceId={workspaceId} label="Add your first credential" />
					</div>
					<ul className="mt-6 grid w-full gap-3 text-left sm:grid-cols-3">
						<li className="rounded-lg border border-border p-3">
							<div aria-hidden>📋</div>
							<div className="mt-2 text-sm font-semibold">Paste</div>
							<p className="mt-1 text-xs text-muted-foreground">
								API key, Bearer, or Basic Auth — for any service you have a raw secret for.
							</p>
						</li>
						<li className="rounded-lg border border-border p-3">
							<div aria-hidden>🔗</div>
							<div className="mt-2 text-sm font-semibold">OAuth</div>
							<p className="mt-1 text-xs text-muted-foreground">
								Connect a service you own; bring your OAuth app, we run the dance.
							</p>
						</li>
						<li className="rounded-lg border border-primary bg-muted p-3">
							<div aria-hidden>💬</div>
							<div className="mt-2 flex items-center gap-1.5 text-sm font-semibold">
								Chat capture <Badge className="px-1.5 py-0 text-[10px]">NEW</Badge>
							</div>
							<p className="mt-1 text-xs text-muted-foreground">
								Paste a key into any chat session. Maskin detects, redacts, and vaults it — you
								scope it in the same message.
							</p>
						</li>
					</ul>
				</div>
			) : (
				<>
					<ul className="flex flex-col">
						{credentials.map((credential) => (
							<li key={credential.id}>
								<Link
									to="/$workspaceId/settings/keychain/$integrationId"
									params={{ workspaceId, integrationId: credential.id }}
									className="flex flex-col gap-1.5 rounded-lg border-b border-border px-2 py-2.5 transition-colors hover:bg-muted sm:flex-row sm:items-center sm:gap-3"
								>
									<div className="min-w-0 flex-1">
										<div className="flex min-w-0 items-center gap-2">
											<span className="truncate text-sm font-medium">
												{credentialName(credential)}
											</span>
											{credential.source === 'chat_capture' && <CapturedViaChatBadge />}
										</div>
										<div className="mt-0.5 truncate text-xs text-muted-foreground">
											{describeScope(credential.scopeGrants, actorName)} ·{' '}
											<RelativeTime date={credential.createdAt} />
										</div>
									</div>
									<div className="flex shrink-0 items-center gap-1.5">
										<Badge variant="outline">{credentialTypeLabel(credential.providerMode)}</Badge>
										<CredentialStatusBadge integration={credential} />
									</div>
								</Link>
							</li>
						))}
					</ul>
					<p className="mt-3 text-center text-xs text-muted-foreground">
						Encrypted at rest. Every use is logged. See any credential for its audit trail.
						{hasChatCaptured && (
							<>
								{' '}
								Credentials with <span aria-hidden>💬</span> Captured via chat were vaulted from a
								live session.
							</>
						)}
					</p>
				</>
			)}
		</div>
	)
}
