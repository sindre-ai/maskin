import { createPrivateKey, createSign } from 'node:crypto'
import { getEnvOrThrow } from '../../env'
import type { CustomAuthHandler, StoredCredentials } from '../../types'

function createJwt(appId: string, privateKeyPem: string): string {
	const now = Math.floor(Date.now() / 1000)
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
	const payload = Buffer.from(
		JSON.stringify({
			iat: now - 60,
			exp: now + 600,
			iss: Number(appId),
		}),
	).toString('base64url')

	// Use createPrivateKey to normalize any PEM format (PKCS#1 or PKCS#8) for OpenSSL 3
	const key = createPrivateKey(privateKeyPem)
	const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key, 'base64url')

	return `${header}.${payload}.${signature}`
}

/**
 * Parse a PEM private key from env, handling multiple formats:
 * 1. Literal \n sequences (common in .env files)
 * 2. Spaces instead of newlines (Coolify and other platforms collapse newlines to spaces)
 * 3. Base64-encoded PEM
 */
function parsePrivateKey(raw: string): string {
	if (raw.includes('-----BEGIN')) {
		const normalized = raw.replace(/\\n/g, '\n').replace(/\\r/g, '')
		const match = normalized.match(/(-----BEGIN [\w ]+-----)\s+([\s\S]+?)\s+(-----END [\w ]+-----)/)
		if (match) {
			const [, header, body = '', footer] = match
			const bodyLines = body.split(/\s+/).join('\n')
			return `${header}\n${bodyLines}\n${footer}\n`
		}
		return normalized
	}
	return Buffer.from(raw, 'base64').toString('utf8')
}

function mintAppJwt(): string {
	const appId = getEnvOrThrow('GITHUB_APP_ID')
	const privateKeyRaw = getEnvOrThrow('GITHUB_APP_PRIVATE_KEY')
	const privateKey = parsePrivateKey(privateKeyRaw)
	return createJwt(appId, privateKey)
}

async function postInstallationAccessToken(
	installationId: string,
	jwt: string,
): Promise<{ ok: boolean; status: number; token?: string; body?: string }> {
	const response = await fetch(
		`https://api.github.com/app/installations/${installationId}/access_tokens`,
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
		return { ok: false, status: response.status, body: await response.text() }
	}
	const data = (await response.json()) as { token: string }
	return { ok: true, status: response.status, token: data.token }
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
		const installationId = credentials.installation_id as string | undefined
		if (!installationId) throw new Error('Missing installation_id on stored credentials')
		const result = await postInstallationAccessToken(installationId, mintAppJwt())
		if (!result.ok || !result.token) {
			throw new Error(
				`Failed to get installation access token: ${result.status} ${result.body ?? ''}`,
			)
		}
		return result.token
	},
}

/** owner/name — the format GitHub uses in `/repos/:owner/:name` — strict enough
 *  to block URL-path injection when we interpolate this into the installation
 *  discovery request below. */
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

async function discoverInstallationForRepo(repo: string, jwt: string): Promise<string> {
	if (!REPO_SLUG_RE.test(repo)) {
		throw new Error(`Invalid repo slug for installation recovery: ${repo}`)
	}
	const response = await fetch(`https://api.github.com/repos/${repo}/installation`, {
		headers: {
			Authorization: `Bearer ${jwt}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
		},
	})
	if (!response.ok) {
		const text = await response.text()
		throw new Error(
			`Failed to discover GitHub App installation for ${repo}: ${response.status} ${text}`,
		)
	}
	const data = (await response.json()) as { id?: number }
	if (typeof data.id !== 'number') {
		throw new Error(`GitHub /repos/${repo}/installation response missing id`)
	}
	return String(data.id)
}

export interface MintTokenResult {
	token: string
	installationId: string
	/** True when the initial mint 404'd on the cached id and discovery landed a fresh install. */
	recovered: boolean
}

export interface MintTokenOptions {
	/** owner/name hint used to re-discover the current install on a stale-cache 404.
	 *  Without it, 404 propagates unchanged (recovery is opt-in). */
	repo?: string
}

/**
 * Mint an App installation access token, recovering from mid-session install
 * churn. Tries the cached installation id first; when GitHub returns 404 on
 * that mint (App reinstalled → cached id rotated out) AND the caller supplied
 * a `repo` hint, re-discovers the current install for that repo via App JWT
 * and mints against it. Any other error is re-thrown so the wrapping tagger
 * can classify it (see error-tagger.ts). Callers that get `recovered: true`
 * should persist the returned `installationId` so subsequent writes skip the
 * recovery round-trip.
 */
export async function mintInstallationTokenWithRecovery(
	credentials: StoredCredentials,
	opts: MintTokenOptions = {},
): Promise<MintTokenResult> {
	const cachedId = credentials.installation_id as string | undefined
	if (!cachedId) throw new Error('Missing installation_id on stored credentials')

	const jwt = mintAppJwt()
	const first = await postInstallationAccessToken(cachedId, jwt)
	if (first.ok && first.token) {
		return { token: first.token, installationId: cachedId, recovered: false }
	}

	if (first.status !== 404 || !opts.repo) {
		throw new Error(`Failed to get installation access token: ${first.status} ${first.body ?? ''}`)
	}

	const recoveredId = await discoverInstallationForRepo(opts.repo, jwt)
	if (recoveredId === cachedId) {
		// Discovery returned the same id — 404 is not from install churn.
		// Re-throw the original error so the tagger stays honest instead of
		// looping mint→discover→mint on the same dead id.
		throw new Error(`Failed to get installation access token: ${first.status} ${first.body ?? ''}`)
	}
	const second = await postInstallationAccessToken(recoveredId, jwt)
	if (!second.ok || !second.token) {
		throw new Error(
			`Failed to mint after install-ID recovery: ${second.status} ${second.body ?? ''}`,
		)
	}
	return { token: second.token, installationId: recoveredId, recovered: true }
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
