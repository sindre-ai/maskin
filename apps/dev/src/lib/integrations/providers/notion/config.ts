import type { ProviderConfig } from '../../types'

export const config: ProviderConfig = {
	name: 'notion',
	displayName: 'Notion',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://api.notion.com/v1/oauth/authorize',
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
			scopes: [],
			pkce: false,
			tokenAuthMethod: 'client_secret_basic',
			extraAuthParams: { owner: 'user' },
			clientIdEnv: 'NOTION_CLIENT_ID',
			clientSecretEnv: 'NOTION_CLIENT_SECRET',
		},
	},

	mcp: {
		command: 'npx',
		args: ['-y', '@notionhq/notion-mcp-server'],
		envKey: 'NOTION_TOKEN',
	},
}
