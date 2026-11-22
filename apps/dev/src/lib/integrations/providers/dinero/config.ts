import type { ProviderConfig } from '../../types'

export const DINERO_PROVIDER = 'dinero'

/**
 * Dinero (Danish accounting), through a personal integration: the owner makes a client
 * id and secret in Dinero, makes an API key for one company, and gives Maskin all three
 * once. Dinero's own MCP only signs in through a Visma browser login that the gateway
 * cannot keep alive, so this is a small tool of ours over Dinero's REST API instead.
 *
 * Connects from a three-field form (routes/integrations-dinero.ts), never a redirect, so
 * `auth.type = 'manual'`: that is what tells the iOS app this is set up from a computer instead
 * of starting an OAuth sheet that cannot work. TokenManager uses `customAuth` (./auth.ts) for the
 * one-hour token whatever the auth type, and the generic connect route must not run for it.
 *
 * MCP is Maskin-hosted at `${MASKIN_API_URL}/api/integrations/dinero/mcp`. The spec
 * references only MASKIN_API_KEY, so the Dinero keys and token never reach a session; the
 * route resolves them server-side. The tools read, and save one kind of draft: none of
 * them books, changes or deletes, and mcp-server.ts refuses any call that would.
 * `autoInject: false` so each agent opts in (or gets it through an access grant).
 */
export const config: ProviderConfig = {
	name: DINERO_PROVIDER,
	displayName: 'Dinero',
	description:
		'Danish accounting. Agents read accounts and contacts and save draft purchase vouchers. Nothing is booked.',

	auth: { type: 'manual' },

	mcp: {
		envKey: 'DINERO_TOKEN',
		autoInject: false,
		server: {
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/dinero/mcp',
			headers: {
				Authorization: 'Bearer ${MASKIN_API_KEY}',
				'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			},
		},
	},
}
