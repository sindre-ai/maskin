import { createPrivateKey, createSign } from 'node:crypto'
import { getEnvOrThrow } from '../../env'
import { ProviderUnreachableError } from '../../errors'
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

// ── User-authorization (user-to-server) flow ───────────────────────────
//
// A GitHub App installs once per org. Sending a *second* workspace to
// `installations/new` dead-ends: GitHub sees the App is already installed on
// the org, silently swaps to that install's configure page, and never calls our
// callback with an `installation_id` — so the workspace can never get a row and
// the connect attempt is left behind as an orphaned `pending`.
//
// `login/oauth/authorize` has no such branch: it always redirects back with
// `code` + our `state`, installed or not. Exchanging that code for a
// *user*-to-server token lets us ask GitHub `GET /user/installations` — every
// installation of this App the authenticated GitHub user can actually reach.
// That is the correct entitlement boundary (real GitHub org membership) and it
// is self-service, unlike `POST /github/link`, which can only offer
// installations reachable from a Maskin workspace the caller already belongs to.

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'

/** One installation of this App that a given GitHub user can reach. */
export interface UserInstallation {
	installationId: string
	ownerLogin: string | null
}

/** Thrown when the authenticated user can reach no installation of this App.
 *  The route turns this into a redirect to the App's install page rather than
 *  an error — "you haven't installed it yet" is a next step, not a failure. */
export class NoGithubInstallationsError extends Error {
	constructor() {
		super('The authenticated GitHub user has no accessible installations of this App')
		this.name = 'NoGithubInstallationsError'
	}
}

/** Thrown when a callback names an `installation_id` the authenticated GitHub
 *  user cannot actually reach — i.e. someone hand-wrote the callback URL. */
export class UnauthorizedGithubInstallationError extends Error {
	constructor(installationId: string) {
		super(`GitHub installation ${installationId} is not reachable by the authenticated user`)
		this.name = 'UnauthorizedGithubInstallationError'
	}
}

/** The App's own install page — where we send a user with zero installations. */
export function buildAppInstallUrl(state: string): string {
	const slug = process.env.GITHUB_APP_SLUG || 'sindre-maskin'
	return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`
}

/** Exchange a user-authorization `code` for a user-to-server access token. */
export async function exchangeUserCode(code: string, redirectUri: string): Promise<string> {
	let response: Response
	try {
		response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: getEnvOrThrow('GITHUB_CLIENT_ID'),
				client_secret: getEnvOrThrow('GITHUB_CLIENT_SECRET'),
				code,
				redirect_uri: redirectUri,
			}),
		})
	} catch (err) {
		throw new ProviderUnreachableError('GitHub user token exchange failed', { cause: err })
	}

	if (!response.ok) {
		throw new ProviderUnreachableError(
			`GitHub user token exchange returned ${response.status}: ${await response.text()}`,
		)
	}

	// GitHub reports OAuth-level failures (bad_verification_code, expired code)
	// as HTTP 200 with an `error` field, so status alone is not enough.
	const data = (await response.json()) as {
		access_token?: string
		error?: string
		error_description?: string
	}
	if (data.error || !data.access_token) {
		throw new Error(
			`GitHub user token exchange rejected: ${data.error ?? 'unknown'}${
				data.error_description ? ` — ${data.error_description}` : ''
			}`,
		)
	}
	return data.access_token
}

/** List every installation of this App reachable by the given user token. */
export async function listUserInstallations(userToken: string): Promise<UserInstallation[]> {
	// per_page=100 in one shot: this lists installations of *this* App only, so
	// the count is bounded by how many orgs the user belongs to that installed
	// Maskin. Paginating past 100 would be dead code for any realistic account.
	let response: Response
	try {
		response = await fetch('https://api.github.com/user/installations?per_page=100', {
			headers: {
				Authorization: `Bearer ${userToken}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
			},
		})
	} catch (err) {
		throw new ProviderUnreachableError('GitHub /user/installations request failed', { cause: err })
	}

	if (!response.ok) {
		throw new ProviderUnreachableError(
			`GitHub /user/installations returned ${response.status}: ${await response.text()}`,
		)
	}

	const data = (await response.json()) as {
		installations?: Array<{ id?: number; account?: { login?: string } }>
	}
	return (data.installations ?? [])
		.filter((i): i is { id: number; account?: { login?: string } } => typeof i.id === 'number')
		.map((i) => ({
			installationId: String(i.id),
			ownerLogin: i.account?.login ?? null,
		}))
}

export const githubAuth: CustomAuthHandler = {
	getInstallUrl(state: string, redirectUri: string): string {
		// User-authorization rather than `installations/new`: this endpoint always
		// returns to our callback, so an org that already has the App installed is
		// a normal case here instead of a dead end. A user with no installation at
		// all still lands correctly — handleCallback routes them to the install
		// page via NoGithubInstallationsError.
		const params = new URLSearchParams({
			client_id: getEnvOrThrow('GITHUB_CLIENT_ID'),
			redirect_uri: redirectUri,
			state,
		})
		return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`
	},

	async handleCallback(
		params: Record<string, string>,
		redirectUri: string,
	): Promise<StoredCredentials> {
		// Every branch below requires a `code`. An `installation_id` arriving on its
		// own is unverifiable — it is a raw query param, and everything downstream
		// mints tokens with the App's own JWT, which succeeds for *any* installation
		// of this App. Honouring it would let anyone bind an org they have no GitHub
		// access to by hand-writing this callback URL with their own `state`, routing
		// around the entitlement check this whole flow exists to enforce.
		//
		// Requires the App's "Request user authorization (OAuth) during installation"
		// setting to be ON, so the post-install callback carries a `code` too.
		const code = params.code
		if (!code) {
			throw new Error('Missing authorization code in GitHub callback')
		}

		const userToken = await exchangeUserCode(code, redirectUri)
		const installations = await listUserInstallations(userToken)

		if (installations.length === 0) {
			throw new NoGithubInstallationsError()
		}

		// Fresh install: GitHub names the installation directly, so there is nothing
		// to disambiguate — but we still confirm the user can reach it rather than
		// trusting the query param.
		const named = params.installation_id
		if (named) {
			if (!installations.some((i) => i.installationId === named)) {
				throw new UnauthorizedGithubInstallationError(named)
			}
			return { installation_id: named }
		}

		const [only] = installations
		if (installations.length === 1 && only) {
			return { installation_id: only.installationId }
		}

		// Ambiguous — the user can reach several orgs' installations. Hand the
		// choices back for the route to park on the pending row; the user picks one
		// via POST /github/select-installation. Deliberately NOT persisting the user
		// token: everything downstream mints App installation tokens, so keeping a
		// user-scoped credential would widen the blast radius for no gain.
		return {
			pending_installation_selection: true,
			installation_choices: installations,
		}
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

/**
 * Thrown when `GET /repos/:repo/installation` returns a non-2xx. Carries the
 * HTTP status so callers can distinguish "App is not installed on this repo"
 * (404 → the caller genuinely needs to reconnect) from transient GitHub
 * failures (5xx / 429 → tell the caller to retry, don't nag them to reconnect).
 * Consumers should key on `err.status`, not on the message text.
 */
export class DiscoveryError extends Error {
	readonly status: number
	readonly repo: string
	readonly body: string
	constructor(repo: string, status: number, body: string) {
		super(`Failed to discover GitHub App installation for ${repo}: ${status} ${body}`)
		this.name = 'DiscoveryError'
		this.status = status
		this.repo = repo
		this.body = body
	}
}

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
		throw new DiscoveryError(repo, response.status, text)
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

	// JWT is valid for 10 minutes (see createJwt above), so the same token
	// safely covers the discovery call and the retry mint in the recovery branch.
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
