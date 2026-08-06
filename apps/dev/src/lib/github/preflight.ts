/**
 * Startup preflight for the GitHub identities attached to a session's MCP
 * launch spec. A missing token short-circuits to `missing-token` without
 * hitting the network, so a session that lost its token can't drop calls
 * into GitHub's 60/hr anonymous bucket.
 *
 * Write scope is verified with a REAL write: `POST /repos/{owner}/{repo}/git/blobs`,
 * which creates an unreferenced blob object. This has no visible side effect —
 * no branch, file, commit, or PR is created, and GitHub garbage-collects the
 * object over time — but it is the only reliable way to confirm push-level
 * access for a GitHub App installation token. The `permissions.push`/`pull`
 * fields on `GET /repos/{owner}/{repo}` and `GET /installation/repositories`
 * model classic collaborator affiliation and do NOT reliably reflect what an
 * App installation token can actually do: confirmed directly against
 * production, an installation with a correct `contents: write` grant (verified
 * via `GET /app/installations/{id}`: not suspended, `repository_selection:
 * all`, target repo present in `/installation/repositories`) still reported
 * `permissions.push: false` on both endpoints, while a real blob-create
 * against that same repo with that same token succeeded outright (HTTP 201).
 * Every prior version of this probe trusted that field — first directly, then
 * cross-checked against a second endpoint, then against the installation's
 * own declared grant — and every version kept agreeing on the same wrong
 * answer, because all three signals share the same flaw. Testing the actual
 * operation sidesteps it entirely.
 *
 * This app is multi-tenant — any number of workspaces can each connect their
 * own GitHub App installation, in their own org, with their own repos. The
 * write-scope probe therefore can NOT test against one hardcoded repo: an
 * installation living in org A has no repo in common with org B. When the
 * caller knows the session's actual resolved target repo (threaded in as
 * `PreflightIdentity.writeProbeRepo`), we probe that exact repo — the most
 * precise signal, since it's the repo the session will actually push to.
 * Otherwise we resolve any one repo the token can see via
 * `GET /installation/repositories` and probe that instead — scoped
 * automatically to the tenant's own org with no per-identity or per-org
 * configuration required.
 *
 * Installation tokens also can never pass `GET /user` — that endpoint
 * requires a user-context token, and an installation token gets a 403
 * "Resource not accessible by integration" there regardless of validity or
 * scope — so installation-token identities skip the /user probe entirely.
 * Non-installation tokens (a user-supplied PAT/OAuth token, not routed
 * through the integrations table) have no "installation" to scope to, so
 * they fall back to the fixed default probe repo.
 *
 * Verdicts are per-session, not global — the caller runs preflight once per
 * launch and uses the result to gate the failing identity's MCP tools for
 * the rest of the session.
 */
import { logger } from '../logger'

/** GitHub App installation access tokens carry this prefix. They authenticate
 *  as the app/installation, not as a user, so `GET /user` always 403s for
 *  them — skip that probe rather than treat it as a real health signal. */
const GITHUB_APP_INSTALLATION_TOKEN_PREFIX = 'ghs_'

function isGitHubAppInstallationToken(token: string): boolean {
	return token.startsWith(GITHUB_APP_INSTALLATION_TOKEN_PREFIX)
}

/** Default Slack channel for preflight alerts — see the parent bet. */
export const GITHUB_PREFLIGHT_SLACK_CHANNEL = 'C075JBZ65RT'

/** Fallback write-scope probe repo, used only for non-installation (PAT/OAuth)
 *  tokens that have no installation to scope `/installation/repositories` to. */
export const GITHUB_PREFLIGHT_DEFAULT_PROBE_REPO = 'sindre-ai/maskin'

/** Names of the four MCP identities this bet is provisioning. Preflight
 *  runs against every discovered github-like identity, not just these — the
 *  list is documentation, not a filter. */
export const GITHUB_PREFLIGHT_KNOWN_IDENTITIES = [
	'github',
	'github_approver',
	'github-sindre-ai',
	'github-vaerksted-ai',
] as const

export type PreflightFailureClass =
	| 'missing-token'
	| '401-unauth'
	| '403-permission'
	| 'anon-rate-limit'
	| 'write-scope-denied'
	| 'network-error'
	| 'user-lookup-failed'

export interface PreflightIdentity {
	/** MCP server key (e.g. `github`, `github_approver`, `github-sindre-ai`). */
	name: string
	/** Resolved bearer token, or null/empty for the missing-token short-circuit. */
	token: string | null | undefined
	/** GitHub App installation ID the token was minted from, when known. Carried
	 *  through to the verdict purely for diagnostics — lets a Slack alert or log
	 *  line show exactly which installation produced an unexpected result, without
	 *  needing to correlate back to the integrations table by hand. */
	installationId?: string
	/** The session's actual resolved target repo (`owner/repo`), when known. For
	 *  installation tokens, this takes priority over `/installation/repositories`
	 *  — checking the exact repo the session will push to is a strictly more
	 *  precise signal than "can this token see any writable repo in its org". */
	writeProbeRepo?: string
}

export interface PreflightVerdict {
	name: string
	healthy: boolean
	failureClass?: PreflightFailureClass
	/** Upstream status + short body snippet, token-scrubbed. Never contains the
	 *  raw token. */
	statusSnippet?: string
	/** See {@link PreflightIdentity.installationId}. */
	installationId?: string
}

export interface PreflightOptions {
	fetchImpl?: typeof fetch
	writeProbeRepo?: string
}

const BODY_SNIPPET_MAX = 200

export async function runGitHubPreflight(
	identities: PreflightIdentity[],
	opts: PreflightOptions = {},
): Promise<PreflightVerdict[]> {
	const fetchImpl = opts.fetchImpl ?? fetch
	const probeRepo = opts.writeProbeRepo ?? GITHUB_PREFLIGHT_DEFAULT_PROBE_REPO
	return Promise.all(identities.map((id) => probeOne(id, fetchImpl, probeRepo)))
}

async function probeOne(
	id: PreflightIdentity,
	fetchImpl: typeof fetch,
	probeRepo: string,
): Promise<PreflightVerdict> {
	const token = id.token
	if (!token || token.length === 0) {
		return {
			name: id.name,
			healthy: false,
			failureClass: 'missing-token',
			statusSnippet: 'no token attached at launch',
			installationId: id.installationId,
		}
	}

	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		'User-Agent': 'maskin-github-preflight/1',
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
	}

	const isInstallationToken = isGitHubAppInstallationToken(token)

	if (!isInstallationToken) {
		let userRes: Response
		try {
			userRes = await fetchImpl('https://api.github.com/user', { headers })
		} catch (err) {
			return {
				name: id.name,
				healthy: false,
				failureClass: 'network-error',
				statusSnippet: scrubToken(String(err), token),
				installationId: id.installationId,
			}
		}
		if (!userRes.ok) {
			return classifyHttpFailure(id.name, userRes, token, '/user', id.installationId)
		}
	}

	// Installation tokens are scoped to a single tenant's own org — probing a
	// fixed repo path would only ever be correct for one hardcoded org, which
	// breaks for every other tenant. When the session's actual target repo is
	// known, probe write scope against that exact repo — it's the most precise
	// signal available. Otherwise resolve any repo the token can see via
	// `/installation/repositories`, which is scoped by the token itself so it
	// still reflects the calling installation's own org regardless of which
	// tenant it belongs to.
	if (isInstallationToken) {
		let repo = id.writeProbeRepo
		if (!repo) {
			const resolved = await resolveAnyAccessibleRepo(
				id.name,
				fetchImpl,
				headers,
				token,
				id.installationId,
			)
			if ('verdict' in resolved) return resolved.verdict
			repo = resolved.repo
		}
		return probeWriteScope(id.name, fetchImpl, headers, token, repo, id.installationId)
	}
	return probeWriteScope(id.name, fetchImpl, headers, token, probeRepo, id.installationId)
}

/** Resolves any one repo an installation token can see, for use when the
 *  caller doesn't know the session's specific target repo. Reuses
 *  `/installation/repositories` purely to name a candidate — the actual
 *  write-scope verdict comes from a real write attempt against it in
 *  {@link probeWriteScope}, not from this endpoint's `permissions` field. */
async function resolveAnyAccessibleRepo(
	name: string,
	fetchImpl: typeof fetch,
	headers: Record<string, string>,
	token: string,
	installationId: string | undefined,
): Promise<{ repo: string } | { verdict: PreflightVerdict }> {
	const path = '/installation/repositories'
	let res: Response
	try {
		res = await fetchImpl(`https://api.github.com${path}?per_page=1`, { headers })
	} catch (err) {
		return {
			verdict: {
				name,
				healthy: false,
				failureClass: 'network-error',
				statusSnippet: scrubToken(String(err), token),
				installationId,
			},
		}
	}
	if (!res.ok) {
		return { verdict: await classifyHttpFailure(name, res, token, path, installationId) }
	}

	let body: unknown
	try {
		body = await res.json()
	} catch {
		return {
			verdict: {
				name,
				healthy: false,
				failureClass: 'user-lookup-failed',
				statusSnippet: `${path}: unparseable JSON`,
				installationId,
			},
		}
	}

	const repos = (body as { repositories?: unknown[] }).repositories
	const repoName =
		Array.isArray(repos) && repos.length > 0 ? extractRepoFullName(repos[0]) : undefined
	if (!repoName) {
		return {
			verdict: {
				name,
				healthy: false,
				failureClass: 'write-scope-denied',
				statusSnippet: `${path}: installation has no accessible repositories`,
				installationId,
			},
		}
	}
	return { repo: repoName }
}

/** Authoritative write-scope check: attempts a real write —
 *  `POST /repos/{repo}/git/blobs`, creating an unreferenced content object —
 *  instead of reading the `permissions.push`/`pull` fields on `GET /repos` or
 *  `GET /installation/repositories`. Those fields model classic collaborator
 *  affiliation and have been confirmed, against production, to report
 *  `push: false` for an installation token that can genuinely push (see file
 *  header). A blob create has no visible side effect — no branch, file,
 *  commit, or PR — and GitHub garbage-collects the object over time, so it's
 *  safe to run on every session launch. */
async function probeWriteScope(
	name: string,
	fetchImpl: typeof fetch,
	headers: Record<string, string>,
	token: string,
	repoFullName: string,
	installationId: string | undefined,
): Promise<PreflightVerdict> {
	const path = `/repos/${repoFullName}/git/blobs`
	let res: Response
	try {
		res = await fetchImpl(`https://api.github.com${path}`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'maskin-github-preflight-write-probe', encoding: 'utf-8' }),
		})
	} catch (err) {
		return {
			name,
			healthy: false,
			failureClass: 'network-error',
			statusSnippet: scrubToken(String(err), token),
			installationId,
		}
	}

	if (res.ok) {
		return { name, healthy: true, installationId }
	}

	// 403/404 on an actual write attempt is the real write-scope-denied signal
	// — unlike the `permissions` field, GitHub only rejects this call when the
	// token truly cannot write to the repo. Anything else (401, 5xx, other
	// unexpected codes) goes through the generic classifier instead of being
	// misreported as a permission issue.
	if (res.status === 403 || res.status === 404) {
		let bodyText = ''
		try {
			bodyText = (await res.text()).slice(0, BODY_SNIPPET_MAX)
		} catch {}
		return {
			name,
			healthy: false,
			failureClass: 'write-scope-denied',
			statusSnippet: `${path}: HTTP ${res.status} ${scrubToken(bodyText, token)}`,
			installationId,
		}
	}

	return classifyHttpFailure(name, res, token, path, installationId)
}

function extractRepoFullName(repo: unknown): string | undefined {
	if (repo === null || typeof repo !== 'object') return undefined
	const fullName = (repo as { full_name?: unknown }).full_name
	return typeof fullName === 'string' ? fullName : undefined
}

async function classifyHttpFailure(
	name: string,
	res: Response,
	token: string,
	path: string,
	installationId?: string,
): Promise<PreflightVerdict> {
	const status = res.status
	let bodyText = ''
	try {
		bodyText = (await res.text()).slice(0, BODY_SNIPPET_MAX)
	} catch {}
	const scrubbed = scrubToken(bodyText, token)
	// A 403 with `X-RateLimit-Remaining: 0` is the anonymous 60/hr trip when the
	// bearer is rejected server-side. When we DID attach a token, this reads as
	// a permission problem instead — anon-rate-limit is only for the missing-
	// token short-circuit path we already handle above.
	if (status === 401) {
		return {
			name,
			healthy: false,
			failureClass: '401-unauth',
			statusSnippet: `HTTP 401 ${path}: ${scrubbed}`,
			installationId,
		}
	}
	if (status === 403) {
		return {
			name,
			healthy: false,
			failureClass: '403-permission',
			statusSnippet: `HTTP 403 ${path}: ${scrubbed}`,
			installationId,
		}
	}
	return {
		name,
		healthy: false,
		failureClass: 'user-lookup-failed',
		statusSnippet: `HTTP ${status} ${path}: ${scrubbed}`,
		installationId,
	}
}

function scrubToken(text: string, token: string): string {
	if (!token || token.length < 8) return text
	return text.split(token).join('<redacted>')
}

// ------------------------------ Slack alert -----------------------------------

export interface SlackAlertOptions {
	fetchImpl?: typeof fetch
}

export interface SlackAlertContext {
	sessionId: string
	workspaceId: string
}

/**
 * Post ONE consolidated alert to Slack naming every failing identity. Never
 * includes the token itself — only identity name, failure class, and the
 * upstream status snippet already scrubbed by {@link runGitHubPreflight}.
 * Silently swallows Slack failures; a Slack outage must not fail-close the
 * session launch.
 */
export async function postGitHubPreflightSlackAlert(params: {
	botToken: string
	channelId: string
	verdicts: PreflightVerdict[]
	context: SlackAlertContext
	options?: SlackAlertOptions
}): Promise<void> {
	const { botToken, channelId, verdicts, context, options } = params
	const unhealthy = verdicts.filter((v) => !v.healthy)
	if (unhealthy.length === 0) return
	if (!botToken) return
	const fetchImpl = options?.fetchImpl ?? fetch
	const lines = unhealthy.map((v) => {
		const installSuffix = v.installationId ? ` (installation ${v.installationId})` : ''
		return `• *${v.name}*${installSuffix} — ${v.failureClass ?? 'unknown'} — ${v.statusSnippet ?? ''}`
	})
	const text = [
		`GitHub preflight failed for ${unhealthy.length} identit${unhealthy.length === 1 ? 'y' : 'ies'} at session launch.`,
		`Session: \`${context.sessionId}\` · Workspace: \`${context.workspaceId}\``,
		lines.join('\n'),
	].join('\n')
	try {
		const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${botToken}`,
				'Content-Type': 'application/json; charset=utf-8',
			},
			body: JSON.stringify({ channel: channelId, text, mrkdwn: true }),
		})
		if (!res.ok) {
			logger.warn('Slack preflight alert non-2xx', {
				sessionId: context.sessionId,
				status: res.status,
			})
		}
	} catch (err) {
		logger.warn('Slack preflight alert failed to post', {
			sessionId: context.sessionId,
			error: String(err),
		})
	}
}

// ---------------------- MCP token extraction helpers --------------------------

/**
 * Resolve a GITHUB_TOKEN value that may be a literal token or a single
 * `${VAR}` envsubst placeholder. Placeholders are looked up in the final
 * container env; unresolved placeholders return null so the caller reports
 * them as `missing-token`.
 */
export function resolveMcpGitHubToken(
	rawValue: unknown,
	envVars: Record<string, string>,
): string | null {
	if (typeof rawValue !== 'string') return null
	const placeholder = rawValue.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
	if (placeholder) {
		const key = placeholder[1]
		if (!key) return null
		const v = envVars[key]
		return v && v.length > 0 ? v : null
	}
	return rawValue.length > 0 ? rawValue : null
}

/**
 * Walk one or more MCP server maps and return the github-like identities we
 * should preflight — every entry whose `env.GITHUB_PERSONAL_ACCESS_TOKEN` is
 * set (the env key `@modelcontextprotocol/server-github` actually reads —
 * see the known-pitfalls entry on `GITHUB_TOKEN` vs
 * `GITHUB_PERSONAL_ACCESS_TOKEN`). Later maps override earlier maps on name
 * collision (matches Object.assign merge semantics used at the launch-spec
 * level).
 */
export function collectGitHubMcpIdentities(
	mcpSources: Array<Record<string, unknown> | undefined | null>,
	envVars: Record<string, string>,
): PreflightIdentity[] {
	const seen = new Map<string, PreflightIdentity>()
	for (const source of mcpSources) {
		if (!source) continue
		for (const [name, entry] of Object.entries(source)) {
			const token = extractGithubTokenFromEntry(entry, envVars)
			if (token === undefined) continue
			seen.set(name, { name, token })
		}
	}
	return Array.from(seen.values())
}

function extractGithubTokenFromEntry(
	entry: unknown,
	envVars: Record<string, string>,
): string | null | undefined {
	if (!entry || typeof entry !== 'object') return undefined
	const env = (entry as { env?: unknown }).env
	if (!env || typeof env !== 'object') return undefined
	const raw = (env as { GITHUB_PERSONAL_ACCESS_TOKEN?: unknown }).GITHUB_PERSONAL_ACCESS_TOKEN
	if (raw === undefined) return undefined
	return resolveMcpGitHubToken(raw, envVars)
}

/**
 * Remove failed identities from an MCP server map. Returns a new object so
 * the caller can decide whether to re-stringify it (e.g. for AGENT_MCP_JSON
 * vs MCP_SERVERS_JSON). Never mutates the input.
 */
export function stripFailedIdentities<T extends Record<string, unknown> | undefined | null>(
	mcpMap: T,
	verdicts: PreflightVerdict[],
): T {
	if (!mcpMap) return mcpMap
	const failed = new Set(verdicts.filter((v) => !v.healthy).map((v) => v.name))
	if (failed.size === 0) return mcpMap
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(mcpMap)) {
		if (!failed.has(k)) out[k] = v
	}
	return out as T
}
