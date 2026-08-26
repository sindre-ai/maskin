import type { ProviderConfig } from '../../types'

export const config: ProviderConfig = {
	name: 'ubersuggest',
	displayName: 'Ubersuggest',
	description: 'SEO keyword, SERP, backlink and site-audit research via the Ubersuggest MCP',

	auth: { type: 'oauth2_custom' },

	// Hosted MCP endpoint that accepts the OAuth bearer token this integration
	// already holds — no custom in-process MCP route (see .claude/rules/integrations.md).
	//
	// `envKey` is what session-manager actually reads to name the injected env
	// var. It matches the `${UBERSUGGEST_TOKEN}` placeholder in the frontend's
	// INTEGRATION_MCP_PRESETS entry; stating it here makes that contract explicit
	// rather than leaning on the uppercase-provider-name fallback happening to
	// produce the same string.
	//
	// No `autoInject`: Ubersuggest is a research tool an author opts into per
	// agent via the quick-add button, not a workspace-level data pipe like
	// PostHog feeding the Synthesizer.
	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://ubersuggest-mcp.neilpatelapi.com/mcp'],
		envKey: 'UBERSUGGEST_TOKEN',
	},
}
