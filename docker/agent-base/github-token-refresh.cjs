'use strict'
	// Preload for the GitHub MCP server (@modelcontextprotocol/server-github).
	// Loaded with NODE_OPTIONS="--require /agent-github-token-refresh.cjs" on the
	// per-owner github-<owner> MCP entries only — never container-wide.
	//
	// GitHub App installation tokens expire after 1 hour with no refresh token,
	// and session-manager bakes one into GITHUB_PERSONAL_ACCESS_TOKEN at launch.
	// The GitHub server reads process.env.GITHUB_PERSONAL_ACCESS_TOKEN on every
	// request (common/utils.js), so re-minting through the Maskin API and writing
	// the result back into process.env is enough — no fork, no restart.
	//
	// Contract (env on the MCP entry; the Developer side must set exactly these):
	//   GITHUB_REFRESH_INTEGRATION_ID  integration id of THIS owner's install
	//   MASKIN_API_URL                 Maskin API base URL
	//   MASKIN_API_KEY                 Maskin API key
	//   MASKIN_WORKSPACE_ID            workspace id (X-Workspace-Id header)
	//   GITHUB_REFRESH_INTERVAL_SEC    optional, default 1800, clamped to 60..3000
	//
	// Safe by construction: does nothing when the env is incomplete, keeps the
	// old token when a mint fails, retries after 60s, never logs the token, and
	// only activates inside the GitHub server process (not npx/npm, which also
	// inherit NODE_OPTIONS).
;(() => {
	const env = process.env
	const integrationId = env.GITHUB_REFRESH_INTEGRATION_ID
	const apiUrl = env.MASKIN_API_URL
	const apiKey = env.MASKIN_API_KEY
	const workspaceId = env.MASKIN_WORKSPACE_ID
	if (!integrationId || !apiUrl || !apiKey || !workspaceId) return
	if (!/server-github/.test(process.argv[1] || '') && env.GITHUB_REFRESH_FORCE !== '1') return
	if (typeof fetch !== 'function') return

	const requested = Number(env.GITHUB_REFRESH_INTERVAL_SEC)
	const intervalSec = Number.isFinite(requested) && requested > 0 ? requested : 1800
	const intervalMs = Math.min(Math.max(intervalSec, 60), 3000) * 1000
	const retryMs = 60 * 1000
	const base = String(apiUrl).replace(/\/+$/, '')
	const url = `${base}/api/integrations/${encodeURIComponent(integrationId)}/github-token`

	function schedule(ms) {
		const timer = setTimeout(refresh, ms)
		if (timer.unref) timer.unref()
	}

	function refresh() {
		fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}`, 'X-Workspace-Id': workspaceId },
			signal: AbortSignal.timeout(10000),
		})
			.then((res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`)
				return res.json()
			})
			.then((body) => {
				if (!body || typeof body.token !== 'string' || !body.token) throw new Error('no token')
				env.GITHUB_PERSONAL_ACCESS_TOKEN = body.token
				schedule(intervalMs)
			})
			.catch((err) => {
				process.stderr.write(
					`[github-token-refresh] mint failed (${err?.message}), keeping old token\n`,
				)
				schedule(retryMs)
			})
	}

	schedule(intervalMs)
})()
