import { githubOwnerLoginToEnvKey } from '@maskin/shared'
import type { ProviderConfig } from '../../types'

// Spawn spec for GitHub's official MCP server (github/github-mcp-server), baked
// into the agent-base image. Toolsets are always explicit: the default set and
// "all" can silently grow on an upstream bump.
export const GITHUB_MCP_SERVER_SPEC = {
	command: 'github-mcp-server',
	args: ['stdio', '--toolsets', 'context,repos,git,issues,pull_requests,actions,users'],
}

// Same server behind the token-refresh supervisor (docker/agent-base/
// github-mcp-supervisor.cjs), which re-mints the 1-hour installation token and
// restarts the child behind a stable pipe. The guard runs the plain binary when
// the image predates the supervisor, so a stale image behaves as today. "$@"
// carries GITHUB_MCP_SERVER_SPEC.args to whichever process runs.
export const GITHUB_MCP_SUPERVISED_SPEC = {
	command: 'sh',
	args: [
		'-c',
		'if [ -f /github-mcp-supervisor.cjs ]; then exec node /github-mcp-supervisor.cjs "$@"; fi; exec github-mcp-server "$@"',
		'github-mcp-server',
		...GITHUB_MCP_SERVER_SPEC.args,
	],
}

export const config: ProviderConfig = {
	name: 'github',
	displayName: 'GitHub',
	description: 'GitHub App integration for repositories, pull requests, issues, and more',

	auth: { type: 'oauth2_custom' },

	webhook: {
		signatureHeader: 'x-hub-signature-256',
		signatureScheme: 'hmac-sha256',
		signaturePrefix: 'sha256=',
		secretEnv: 'GITHUB_APP_WEBHOOK_SECRET',
		eventTypeHeader: 'x-github-event',
	},

	events: {
		definitions: [
			{
				entityType: 'github.pull_request',
				actions: ['opened', 'closed', 'synchronize', 'review_requested', 'merged'],
				label: 'Pull Request',
			},
			{
				entityType: 'github.issue',
				actions: ['opened', 'closed', 'labeled', 'assigned'],
				label: 'Issue',
			},
			{
				entityType: 'github.push',
				actions: ['pushed'],
				label: 'Push',
			},
			{
				entityType: 'github.review',
				actions: ['submitted', 'dismissed'],
				label: 'Pull Request Review',
			},
		],
	},

	// GitHub is auto-injected, but not through the generic `autoInject` branch in
	// session-manager.ts — it takes the provider-specific branch above it, which
	// writes ONE entry per installation (`github-<owner>`, e.g. github-sindre-ai)
	// carrying that installation's literal token, so an agent in a multi-org
	// workspace can target a specific org. `autoInject: true` is still the honest
	// answer to a client asking "do I have to attach anything?": no.
	//
	// Deliberately no `server`, and this is the one provider allowed to omit it.
	// There is no single paste-ready spec to state: the entry name varies per
	// installation and the token is baked in, not an env placeholder. A generic
	// `github` entry using ${GITHUB_TOKEN} would look right and quietly bind to
	// the FIRST installation only (session-manager.ts aliases the bare var for
	// backwards compatibility), silently undoing the per-org targeting.
	mcp: {
		command: GITHUB_MCP_SERVER_SPEC.command,
		args: GITHUB_MCP_SERVER_SPEC.args,
		envKey: 'GITHUB_TOKEN',
		autoInject: true,
		// An agent's copy is a stdio entry whose token env points at
		// `${GITHUB_TOKEN_<OWNER>}` (mcp-servers.tsx, handleAddGithub), so it is
		// recognised by that variable, not by a URL.
		entry: {
			kind: 'per-installation',
			envKey: (owner) => {
				const login = (owner.config as { owner_login?: unknown } | null)?.owner_login
				return typeof login === 'string' && login
					? `GITHUB_TOKEN_${githubOwnerLoginToEnvKey(login)}`
					: null
			},
		},
	},
}
