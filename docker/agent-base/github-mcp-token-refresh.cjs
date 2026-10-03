'use strict'
// Preload for @modelcontextprotocol/server-github (node --require, via
// NODE_OPTIONS). Keeps the server's GitHub App installation token fresh.
//
// Why: the tools config starts each github-<owner> MCP server with a single
// GITHUB_PERSONAL_ACCESS_TOKEN taken from the session env. That token is a
// GitHub App installation token (ghs_), valid for exactly 1 hour, and the
// server never refreshes it, so any session running past the 1h mark gets
// "Bad credentials" from every github tool. Git already avoids this by minting
// per call (github-credential-helper.sh); this is the MCP equivalent and mints
// through the same /api/integrations/:id/github-token route.
//
// How: server-github builds every request in one place (githubRequest) and
// calls the *global* fetch, reading the token from process.env at call time.
// We wrap globalThis.fetch for api.github.com: when the token is older than
// the refresh threshold we mint a new one, update process.env and rewrite the
// Authorization header on that request. A 401 also triggers one mint + retry.
//
// Fail-safe: any problem (missing env, mint failure, unexpected request shape)
// falls through to the original token and the original fetch, i.e. today's
// behaviour. Output goes to stderr only; stdout is the MCP stdio channel.
// Tokens are never logged.
//
// Env (all set by the session except the two GITHUB_MCP_* knobs):
//   GITHUB_PERSONAL_ACCESS_TOKEN   token the server was launched with
//   GITHUB_MCP_OWNER               org login this server serves (e.g. sindre-ai);
//                                  selects the integration whose config.owner_login matches
//   GITHUB_MCP_REFRESH_AFTER_MS    token age that triggers a mint (default 50 min)
//   MASKIN_API_URL / MASKIN_API_KEY / MASKIN_WORKSPACE_ID
//   GITHUB_REPO                    optional owner/name hint, used only if its owner matches

const DEFAULT_REFRESH_AFTER_MS = 50 * 60 * 1000
const MINT_TIMEOUT_MS = 10 * 1000
const MINT_RETRY_BACKOFF_MS = 30 * 1000
const API_HOST = 'api.github.com'

function log(msg) {
	process.stderr.write(`[github-mcp-token-refresh] ${msg}\n`)
}

function install() {
	const owner = (process.env.GITHUB_MCP_OWNER || '').trim().toLowerCase()
	const apiUrl = (process.env.MASKIN_API_URL || '').replace(/\/+$/, '')
	const apiKey = process.env.MASKIN_API_KEY
	const workspaceId = process.env.MASKIN_WORKSPACE_ID

	// Only act inside the GitHub MCP server. NODE_OPTIONS also reaches npx's own
	// node process, which must be left alone.
	const entry = process.argv[1] || ''
	if (!/server-github/.test(entry)) return
	if (!process.env.GITHUB_PERSONAL_ACCESS_TOKEN) return
	if (!owner || !apiUrl || !apiKey || !workspaceId) {
		log('disabled: GITHUB_MCP_OWNER / MASKIN_API_URL / MASKIN_API_KEY / MASKIN_WORKSPACE_ID not all set')
		return
	}
	if (typeof globalThis.fetch !== 'function') {
		log('disabled: no global fetch')
		return
	}

	const realFetch = globalThis.fetch.bind(globalThis)
	const parsedAfter = Number.parseInt(process.env.GITHUB_MCP_REFRESH_AFTER_MS || '', 10)
	const refreshAfterMs = parsedAfter > 0 ? parsedAfter : DEFAULT_REFRESH_AFTER_MS

	// The launch token was minted just before this process started, so process
	// start approximates its age (a few seconds early, well inside the 10 min
	// margin of the default threshold).
	let mintedAt = Date.now()
	let integrationId = null
	let inflight = null
	let lastFailureAt = 0

	const headers = () => ({
		Authorization: `Bearer ${apiKey}`,
		'X-Workspace-Id': workspaceId,
	})

	async function getJson(url) {
		const res = await realFetch(url, {
			headers: headers(),
			signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
		})
		if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname.replace(/[0-9a-f-]{36}/g, ':id')}`)
		return res.json()
	}

	async function resolveIntegrationId() {
		if (integrationId) return integrationId
		const list = await getJson(`${apiUrl}/api/integrations`)
		const match = (Array.isArray(list) ? list : []).find(
			(i) =>
				i &&
				i.provider === 'github' &&
				i.status === 'active' &&
				String((i.config && i.config.owner_login) || '').toLowerCase() === owner,
		)
		if (!match) throw new Error(`no active github integration with owner_login=${owner}`)
		integrationId = match.id
		return integrationId
	}

	async function mint() {
		const id = await resolveIntegrationId()
		let query = ''
		const repo = process.env.GITHUB_REPO || ''
		if (repo.split('/')[0].toLowerCase() === owner) query = `?repo=${encodeURIComponent(repo)}`
		const body = await getJson(`${apiUrl}/api/integrations/${id}/github-token${query}`)
		if (!body || typeof body.token !== 'string' || !body.token) throw new Error('mint response had no token')
		return body.token
	}

	// Single-flight: concurrent tool calls share one mint.
	function refresh(reason) {
		if (inflight) return inflight
		if (Date.now() - lastFailureAt < MINT_RETRY_BACKOFF_MS) return Promise.resolve(false)
		inflight = mint()
			.then((token) => {
				process.env.GITHUB_PERSONAL_ACCESS_TOKEN = token
				mintedAt = Date.now()
				log(`token refreshed (${reason}, owner=${owner})`)
				return true
			})
			.catch((err) => {
				lastFailureAt = Date.now()
				log(`refresh failed (${reason}, owner=${owner}): ${err && err.message ? err.message : err}`)
				return false
			})
			.finally(() => {
				inflight = null
			})
		return inflight
	}

	function isGithubApi(input) {
		try {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url
			return new URL(url).hostname === API_HOST
		} catch {
			return false
		}
	}

	// Rewrite Authorization on a plain-object / Headers / tuple-array headers init.
	function withAuth(init, token) {
		const next = { ...(init || {}) }
		const h = next.headers
		if (h instanceof Headers) {
			const copy = new Headers(h)
			copy.set('Authorization', `Bearer ${token}`)
			next.headers = copy
		} else if (Array.isArray(h)) {
			next.headers = h.filter(([k]) => String(k).toLowerCase() !== 'authorization').concat([['Authorization', `Bearer ${token}`]])
		} else {
			const copy = {}
			for (const [k, v] of Object.entries(h || {})) if (k.toLowerCase() !== 'authorization') copy[k] = v
			copy.Authorization = `Bearer ${token}`
			next.headers = copy
		}
		return next
	}

	globalThis.fetch = async function githubAwareFetch(input, init) {
		// Requests carrying a Request object (no init) are not what server-github
		// sends; leave anything unexpected untouched.
		if (!isGithubApi(input) || typeof input !== 'string' || !process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
			return realFetch(input, init)
		}
		if (Date.now() - mintedAt >= refreshAfterMs) await refresh('age')
		const res = await realFetch(input, withAuth(init, process.env.GITHUB_PERSONAL_ACCESS_TOKEN))
		if (res.status !== 401) return res
		// Token rejected (expired early, rotated, ...): one mint + one retry. Only
		// string bodies are replayable; server-github always sends JSON strings.
		const body = init && init.body
		if (body !== undefined && typeof body !== 'string') return res
		if (!(await refresh('401'))) return res
		return realFetch(input, withAuth(init, process.env.GITHUB_PERSONAL_ACCESS_TOKEN))
	}

	log(`active (owner=${owner}, refresh after ${Math.round(refreshAfterMs / 1000)}s)`)
}

try {
	install()
} catch (err) {
	log(`disabled: ${err && err.message ? err.message : err}`)
}
