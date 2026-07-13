import { mintAppJwtFromEnv } from './app-jwt'

/**
 * The sindre-ai-agents GitHub App is a distinct identity from the customer-facing
 * sindre-maskin App. It is registered on the sindre-ai org to back four unattended
 * agent identities (`github`, `github_approver`, `github-sindre-ai`,
 * `github-vaerksted-ai`) that write to sindre-ai repos as part of Maskin's own
 * dev pipeline. Keeping the credential pair independent from the customer-facing
 * App means rotating one never rolls the other — the point of the parent bet.
 *
 * Manifest + installation walkthrough: `.github/agent-app/`
 */
const AGENT_APP_ID_ENV = 'GITHUB_APP_ID_SINDRE_AI'
const AGENT_APP_PRIVATE_KEY_ENV = 'GITHUB_APP_PRIVATE_KEY_SINDRE_AI'
const AGENT_APP_INSTALLATION_ID_ENV = 'GITHUB_APP_INSTALLATION_ID_SINDRE_AI'

/**
 * Return the sindre-ai-agents installation id from env, or null when any of the
 * three App env vars (id / private key / installation id) is missing. Callers
 * skip minting instead of throwing when this returns null — that's what keeps
 * session-manager working on environments where the App hasn't been installed
 * yet (before Magnus completes the org walkthrough).
 */
export function readAgentAppInstallationId(env: NodeJS.ProcessEnv = process.env): string | null {
	const installationId = env[AGENT_APP_INSTALLATION_ID_ENV]
	if (!installationId) return null
	if (!env[AGENT_APP_ID_ENV] || !env[AGENT_APP_PRIVATE_KEY_ENV]) return null
	return installationId
}

/**
 * Ask GitHub to issue a fresh installation access token for the sindre-ai-agents
 * App. Tokens live ~1 hour and can be narrowed at issue time via
 * `repositories` and `permissions` (see the parent bet's per-request scoping
 * task). Optional narrowing fields are omitted from the request body when unset,
 * which yields a token with the App's full installed scope.
 *
 * Callers pass the installation id captured during the org admin walkthrough
 * (stored alongside the App id in the deployment env store).
 */
export interface MintAgentAppInstallationTokenParams {
	installationId: string
	/** Optional: narrow the token to specific repositories on this installation. */
	repositories?: string[]
	/** Optional: narrow the token to a subset of the installation's permissions. */
	permissions?: Record<string, string>
}

export interface AgentAppInstallationToken {
	/** Prefixed `ghs_` — matches the DoD evidence gate in the parent bet. */
	token: string
	/** ISO-8601 timestamp; ~1h from issue time per GitHub's contract. */
	expiresAt: string
}

export async function mintAgentAppInstallationToken(
	params: MintAgentAppInstallationTokenParams,
): Promise<AgentAppInstallationToken> {
	const jwt = mintAppJwtFromEnv(AGENT_APP_ID_ENV, AGENT_APP_PRIVATE_KEY_ENV)

	const body: Record<string, unknown> = {}
	if (params.repositories && params.repositories.length > 0) {
		body.repositories = params.repositories
	}
	if (params.permissions && Object.keys(params.permissions).length > 0) {
		body.permissions = params.permissions
	}

	const response = await fetch(
		`https://api.github.com/app/installations/${encodeURIComponent(params.installationId)}/access_tokens`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${jwt}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'Content-Type': 'application/json',
			},
			body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
		},
	)

	if (!response.ok) {
		const text = await response.text()
		throw new Error(
			`Failed to mint sindre-ai-agents installation token: ${response.status} ${text}`,
		)
	}

	const data = (await response.json()) as { token: string; expires_at: string }
	if (!data.token || !data.expires_at) {
		throw new Error('sindre-ai-agents installation token response missing token or expires_at')
	}
	return { token: data.token, expiresAt: data.expires_at }
}
