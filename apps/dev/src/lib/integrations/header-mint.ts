import { listProviders } from './registry'
import type { HeaderMintAdapter, HeaderMintContext } from './types'

const adapters = new Map<string, HeaderMintAdapter>()

/** Layer 1.6 registers an adapter here; a credential opts in with metadata.adapterKind. */
export function registerHeaderMintAdapter(adapter: HeaderMintAdapter): void {
	adapters.set(adapter.kind, adapter)
}

export function getHeaderMintAdapter(kind: string): HeaderMintAdapter | undefined {
	return adapters.get(kind)
}

/** For tests. */
export function clearHeaderMintAdapters(): void {
	adapters.clear()
}

// A stored value is either a bare secret or a JSON blob carrying accessToken.
function secretOf(value: string): string {
	try {
		const parsed: unknown = JSON.parse(value)
		if (parsed && typeof parsed === 'object' && 'accessToken' in parsed) {
			const token = (parsed as { accessToken: unknown }).accessToken
			if (typeof token === 'string') return token
		}
	} catch {
		// not JSON: a bare secret
	}
	return value
}

/**
 * Vault-mode headers, synthesised from the stored value. A registered api_key
 * provider says which header it wants; everything else gets a Bearer token.
 */
export function vaultHeaders(provider: string, value: string): Record<string, string> {
	const secret = secretOf(value)
	const auth = listProviders().find((p) => p.config.name === provider)?.config.auth
	if (auth?.type === 'api_key') {
		return { [auth.config.headerName]: `${auth.config.headerPrefix ?? ''}${secret}` }
	}
	return { Authorization: `Bearer ${secret}` }
}

export async function mintHeaders(
	adapterKind: string,
	integrationId: string,
	ctx: HeaderMintContext,
): Promise<Record<string, string>> {
	const adapter = adapters.get(adapterKind)
	if (!adapter) throw new Error(`No header-mint adapter registered for ${adapterKind}`)
	return adapter.mint(integrationId, ctx)
}
