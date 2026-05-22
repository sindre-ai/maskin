import type { ProviderConfig } from '../../types'

export const config: ProviderConfig = {
	name: 'linkedin',
	displayName: 'LinkedIn',
	description:
		'LinkedIn integration via session cookies — messaging, profiles, search, and connections',

	// LinkedIn has no usable OAuth2 flow for what we want agents to do.
	// We masquerade as oauth2_custom: the "install URL" path is replaced by a
	// frontend modal that streams a headful Chromium login back to the user,
	// captures session cookies, and stores them in the credentials blob.
	auth: { type: 'oauth2_custom' },

	// MCP command/args are placeholders until Module E vendors the cookie-capable fork.
	// envKey follows the framework default (provider.toUpperCase() + '_TOKEN') so the
	// session-manager env injection at session-manager.ts:743 works without change.
	mcp: {
		command: 'uvx',
		args: ['linkedin-mcp-server'],
		envKey: 'LINKEDIN_TOKEN',
	},
}
