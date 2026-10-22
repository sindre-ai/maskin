import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import type { IntegrationResponse } from '@/lib/api'
import { Link } from '@tanstack/react-router'

/** Rows the Keychain lists: held by the member (paste or chat), not the registered providers,
 *  and not a key that was undone (the row is kept for the audit chain, the key is gone). */
export function isKeychainCredential(integration: IntegrationResponse): boolean {
	return (
		(integration.providerMode === 'byo_apikey' ||
			integration.providerMode === 'byo_login' ||
			integration.providerMode === 'byo_oauth') &&
		integration.status !== 'undone'
	)
}

export function credentialTypeLabel(mode: IntegrationResponse['providerMode']): string {
	if (mode === 'byo_oauth') return 'OAuth'
	return mode === 'byo_login' ? 'Login' : 'API key'
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

/** Keychain › {current page}, shown on the add form. */
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
