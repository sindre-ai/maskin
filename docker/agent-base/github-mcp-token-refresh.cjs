// Preload for the GitHub MCP server (@modelcontextprotocol/server-github).
// Loaded via NODE_OPTIONS=--require=... on the github-<owner> MCP entries only.
//
// GitHub App installation tokens die after exactly 1 hour with no refresh
// token. The server reads process.env.GITHUB_PERSONAL_ACCESS_TOKEN on every
// request, so re-minting the token here and writing it back to process.env is
// enough to keep a long session's GitHub writes working. The token is never
// logged.
//
// Inputs (set per MCP entry, deliberately distinct from the container-wide
// GITHUB_INTEGRATION_ID that the git credential helper uses, so an entry
// without its own id can never mint another owner's token):
//   GITHUB_MCP_REFRESH_INTEGRATION_ID  integration to mint for (required)
//   GITHUB_MCP_REFRESH_API_URL         Maskin API base URL (required)
//   GITHUB_MCP_REFRESH_API_KEY         Maskin API key (required)
//   GITHUB_MCP_REFRESH_WORKSPACE_ID    workspace id (required)
//   GITHUB_MCP_REFRESH_REPO            owner/name, optional, same as the helper
//   GITHUB_MCP_REFRESH_INTERVAL_MS     optional, default 1800000 (30 min)
//
// Any missing input, or a mint failure, leaves the existing token untouched.
'use strict';

const path = require('node:path');

const env = process.env;
const id = env.GITHUB_MCP_REFRESH_INTEGRATION_ID;
const apiUrl = env.GITHUB_MCP_REFRESH_API_URL;
const apiKey = env.GITHUB_MCP_REFRESH_API_KEY;
const workspaceId = env.GITHUB_MCP_REFRESH_WORKSPACE_ID;

// npx/npm stay alive as the parent of the server and inherit NODE_OPTIONS;
// only the server process itself should refresh.
const entry = path.basename(process.argv[1] || '');
const isNpmWrapper = entry === 'npx-cli.js' || entry === 'npm-cli.js';

if (id && apiUrl && apiKey && workspaceId && !isNpmWrapper) {
  const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
  const RETRY_MS = 60 * 1000;
  const TIMEOUT_MS = 15 * 1000;
  const parsed = Number(env.GITHUB_MCP_REFRESH_INTERVAL_MS);
  const intervalMs = Number.isFinite(parsed) && parsed >= 1000 ? parsed : DEFAULT_INTERVAL_MS;

  let url = `${apiUrl.replace(/\/+$/, '')}/api/integrations/${encodeURIComponent(id)}/github-token`;
  if (env.GITHUB_MCP_REFRESH_REPO) {
    url += `?repo=${encodeURIComponent(env.GITHUB_MCP_REFRESH_REPO)}`;
  }

  const schedule = (ms) => setTimeout(refresh, ms).unref();

  async function refresh() {
    let next = intervalMs;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, 'X-Workspace-Id': workspaceId },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (typeof body.token !== 'string' || !body.token || /\s/.test(body.token)) {
        throw new Error('no usable token in response');
      }
      process.env.GITHUB_PERSONAL_ACCESS_TOKEN = body.token;
    } catch (err) {
      // Keep the old token and retry sooner. err.message carries no token.
      next = Math.min(RETRY_MS, intervalMs);
      process.stderr.write(`[github-mcp-token-refresh] mint failed, keeping current token: ${err && err.message}\n`);
    }
    schedule(next);
  }

  schedule(intervalMs);
}
