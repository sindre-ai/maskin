import type { CustomAuthHandler, StoredCredentials } from '../../types'
import { mintAppJwtFromEnv } from './app-jwt'

function mintAppJwt(): string {
	return mintAppJwtFromEnv('GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY')
}

export const githubAuth: CustomAuthHandler = {
	getInstallUrl(state: string): string {
		return `https://github.com/apps/${process.env.GITHUB_APP_SLUG || 'sindre-maskin'}/installations/new?state=${encodeURIComponent(state)}`
	},

	async handleCallback(params: Record<string, string>): Promise<StoredCredentials> {
		const installationId = params.installation_id
		if (!installationId) {
			throw new Error('Missing installation_id in callback')
		}
		return { installation_id: installationId }
	},

	async getAccessToken(credentials: StoredCredentials): Promise<string> {
		const jwt = mintAppJwt()

		const response = await fetch(
			`https://api.github.com/app/installations/${credentials.installation_id}/access_tokens`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${jwt}`,
					Accept: 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28',
				},
			},
		)

		if (!response.ok) {
			const text = await response.text()
			throw new Error(`Failed to get installation access token: ${response.status} ${text}`)
		}

		const data = (await response.json()) as { token: string }
		return data.token
	},
}

/**
 * Fetch the `account.login` (org or user) for a GitHub App installation.
 * Used to disambiguate multiple installations on the same workspace by owner.
 */
export async function fetchInstallationOwnerLogin(installationId: string): Promise<string> {
	const jwt = mintAppJwt()

	const response = await fetch(`https://api.github.com/app/installations/${installationId}`, {
		headers: {
			Authorization: `Bearer ${jwt}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
		},
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`Failed to fetch installation owner: ${response.status} ${text}`)
	}

	const data = (await response.json()) as { account?: { login?: string } }
	const login = data.account?.login
	if (!login || typeof login !== 'string') {
		throw new Error('GitHub installation response missing account.login')
	}
	return login
}
