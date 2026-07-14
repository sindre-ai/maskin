/**
 * Startup preflight for the GitHub identities attached to a session's MCP
 * launch spec. Each identity gets one authenticated read (`GET /user`) and one
 * non-mutating write-scope probe (`GET /repos/<probe>` — checks
 * `permissions.push`). A missing token short-circuits to `missing-token`
 * without hitting the network, so a session that lost its token can't drop
 * calls into GitHub's 60/hr anonymous bucket.
 *
 * Verdicts are per-session, not global — the caller runs preflight once per
 * launch and uses the result to gate the failing identity's MCP tools for
 * the rest of the session.
 */
import { logger } from '../logger'

/** Default Slack channel for preflight alerts — see the parent bet. */
export const GITHUB_PREFLIGHT_SLACK_CHANNEL = 'C075JBZ65RT'

/** Default write-scope probe repo — chosen because the bet's target write
 *  path is exactly this repo; any identity that can't read this repo can't
 *  push to it either. */
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
}

export interface PreflightVerdict {
	name: string
	healthy: boolean
	failureClass?: PreflightFailureClass
	/** Upstream status + short body snippet, token-scrubbed. Never contains the
	 *  raw token. */
	statusSnippet?: string
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
		}
	}

	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		'User-Agent': 'maskin-github-preflight/1',
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
	}

	let userRes: Response
	try {
		userRes = await fetchImpl('https://api.github.com/user', { headers })
	} catch (err) {
		return {
			name: id.name,
			healthy: false,
			failureClass: 'network-error',
			statusSnippet: scrubToken(String(err), token),
		}
	}
	if (!userRes.ok) {
		return classifyHttpFailure(id.name, userRes, token, '/user')
	}

	let repoRes: Response
	try {
		repoRes = await fetchImpl(`https://api.github.com/repos/${probeRepo}`, { headers })
	} catch (err) {
		return {
			name: id.name,
			healthy: false,
			failureClass: 'network-error',
			statusSnippet: scrubToken(String(err), token),
		}
	}
	if (!repoRes.ok) {
		return classifyHttpFailure(id.name, repoRes, token, `/repos/${probeRepo}`)
	}

	let repoBody: unknown
	try {
		repoBody = await repoRes.json()
	} catch {
		return {
			name: id.name,
			healthy: false,
			failureClass: 'user-lookup-failed',
			statusSnippet: `/repos/${probeRepo}: unparseable JSON`,
		}
	}

	const push = extractPushPermission(repoBody)
	if (push !== true) {
		return {
			name: id.name,
			healthy: false,
			failureClass: 'write-scope-denied',
			statusSnippet: `/repos/${probeRepo}: permissions.push is ${JSON.stringify(push)}`,
		}
	}

	return { name: id.name, healthy: true }
}

function extractPushPermission(body: unknown): unknown {
	if (body === null || typeof body !== 'object') return undefined
	const perms = (body as { permissions?: unknown }).permissions
	if (perms === null || typeof perms !== 'object') return undefined
	return (perms as { push?: unknown }).push
}

async function classifyHttpFailure(
	name: string,
	res: Response,
	token: string,
	path: string,
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
		}
	}
	if (status === 403) {
		return {
			name,
			healthy: false,
			failureClass: '403-permission',
			statusSnippet: `HTTP 403 ${path}: ${scrubbed}`,
		}
	}
	return {
		name,
		healthy: false,
		failureClass: 'user-lookup-failed',
		statusSnippet: `HTTP ${status} ${path}: ${scrubbed}`,
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
	const lines = unhealthy.map(
		(v) => `• *${v.name}* — ${v.failureClass ?? 'unknown'} — ${v.statusSnippet ?? ''}`,
	)
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
 * should preflight — every entry whose `env.GITHUB_TOKEN` is set. Later
 * maps override earlier maps on name collision (matches Object.assign merge
 * semantics used at the launch-spec level).
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
	const raw = (env as { GITHUB_TOKEN?: unknown }).GITHUB_TOKEN
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
