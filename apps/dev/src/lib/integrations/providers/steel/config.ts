import type { ProviderConfig } from '../../types'

export const config: ProviderConfig = {
	name: 'steel',
	displayName: 'Steel',
	description: 'Cloud browser automation with anti-detection for agent workflows',

	auth: {
		type: 'api_key',
		config: {
			headerName: 'X-Steel-Api-Key',
			envKeyName: 'STEEL_API_KEY',
		},
	},

	mcp: {
		command: 'npx',
		args: ['-y', '@steel-dev/steel-mcp-server'],
		envKey: 'STEEL_API_KEY',
	},
}
