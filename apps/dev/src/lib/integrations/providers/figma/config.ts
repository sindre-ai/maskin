import type { ProviderConfig } from '../../types'

export const config: ProviderConfig = {
	name: 'figma',
	displayName: 'Figma',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://www.figma.com/oauth',
			tokenUrl: 'https://api.figma.com/v1/oauth/token',
			refreshUrl: 'https://api.figma.com/v1/oauth/refresh',
			scopes: [
				'file_content:read',
				'file_comments:read',
				'file_comments:write',
				'file_dev_resources:read',
				'current_user:read',
			],
			pkce: true,
			tokenAuthMethod: 'client_secret_basic',
			clientIdEnv: 'FIGMA_CLIENT_ID',
			clientSecretEnv: 'FIGMA_CLIENT_SECRET',
		},
	},

	mcp: {
		command: 'npx',
		args: ['-y', 'figma-mcp'],
		envKey: 'FIGMA_TOKEN',
	},
}
