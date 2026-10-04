import { Badge } from '@/components/ui/badge'
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import type { IntegrationResponse, KeychainScopeGrant } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'

/** Rows the Keychain lists: held by the member (paste or chat), not the registered providers,
 *  and not a key that was undone (the row is kept for the audit chain, the key is gone). */
export function isKeychainCredential(integration: IntegrationResponse): boolean {
	return (
		(integration.providerMode === 'byo_apikey' || integration.providerMode === 'byo_oauth') &&
		integration.status !== 'undone'
	)
}

export function credentialTypeLabel(mode: IntegrationResponse['providerMode']): string {
	return mode === 'byo_oauth' ? 'OAuth' : 'API key'
}

const PROVIDER_LABELS: Record<string, string> = {
	cloudflare: 'Cloudflare',
	github: 'GitHub',
	stripe: 'Stripe',
	slack: 'Slack',
	'openai-style': 'OpenAI-style',
	custom: 'Custom',
}

export function providerLabel(provider: string): string {
	return PROVIDER_LABELS[provider] ?? provider
}

export function credentialName(integration: IntegrationResponse): string {
	return integration.displayName?.trim() || providerLabel(integration.provider)
}

export function isUnassigned(integration: IntegrationResponse): boolean {
	return (integration.scopeGrants ?? []).length === 0
}

/** Plain-words scope: who can read this credential. Names come from the workspace's actors. */
export function describeScope(
	grants: KeychainScopeGrant[] | undefined,
	actorName: (actorId: string) => string | undefined,
): string {
	if (!grants || grants.length === 0) return 'No agents — fail-closed'
	const labels: string[] = []
	let loops = 0
	for (const grant of grants) {
		if (grant.kind === 'workspace') labels.push('Whole workspace')
		else if (grant.kind === 'loop') loops += 1
		else labels.push(actorName(grant.actorId) ?? 'Unknown member')
	}
	if (loops > 0) labels.push(loops === 1 ? '1 loop' : `${loops} loops`)
	const [first, ...rest] = labels
	return rest.length > 0 ? `${first} + ${rest.length} more` : (first ?? '')
}

export function CredentialStatusBadge({ integration }: { integration: IntegrationResponse }) {
	return isUnassigned(integration) ? (
		<Badge variant="outline">Unassigned</Badge>
	) : (
		<Badge variant="secondary">Connected</Badge>
	)
}

export function CapturedViaChatBadge({
	children = 'Captured via chat',
	className,
}: {
	children?: React.ReactNode
	className?: string
}) {
	return (
		<Badge
			variant="secondary"
			className={cn('shrink-0 gap-1', className)}
			title="This credential was captured through an in-chat message and vaulted automatically"
		>
			<span aria-hidden>💬</span>
			{children}
		</Badge>
	)
}

/** Keychain › {current page}, shared by the add form and the credential detail. */
export function KeychainBreadcrumb({
	workspaceId,
	current,
}: {
	workspaceId: string
	current: string
}) {
	return (
		<Breadcrumb className="mb-3">
			<BreadcrumbList>
				<BreadcrumbItem>
					<BreadcrumbLink asChild>
						<Link to="/$workspaceId/settings/keychain" params={{ workspaceId }}>
							Keychain
						</Link>
					</BreadcrumbLink>
				</BreadcrumbItem>
				<BreadcrumbSeparator />
				<BreadcrumbItem>
					<BreadcrumbPage>{current}</BreadcrumbPage>
				</BreadcrumbItem>
			</BreadcrumbList>
		</Breadcrumb>
	)
}
