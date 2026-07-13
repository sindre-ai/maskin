import type { StoredCredentials } from '../../types'
import { githubAuth } from './auth'
import type { TokenContext } from './error-tagger'

/**
 * Mint a GitHub App installation access token and stamp the metadata the
 * classifier needs to distinguish `token-expired-mid-session` from a generic
 * `401-unauth`. T4 owns the mint/refresh code path in `auth.ts` — this helper
 * only decorates the result of `githubAuth.getAccessToken` with a mint
 * timestamp and the installation ID that was used. When T4 lands its refresh
 * strategy, callers keep this shape unchanged.
 */
export interface MintedToken {
	token: string
	mintedAt: number
	installationId: string
}

export async function mintInstallationToken(credentials: StoredCredentials): Promise<MintedToken> {
	const installationId = credentials.installation_id
	if (typeof installationId !== 'string' || installationId.length === 0) {
		throw new Error('Missing installation_id on stored GitHub credentials')
	}
	const mintedAt = Date.now()
	const token = await githubAuth.getAccessToken(credentials)
	return { token, mintedAt, installationId }
}

/** Project a MintedToken down to the TokenContext shape the classifier uses. */
export function toTokenContext(m: MintedToken): TokenContext {
	return { mintedAt: m.mintedAt, installationId: m.installationId }
}
