import type { ProviderConfig } from '../../types'

export const ZOOM_PROVIDER = 'zoom'

const MCP_URL = 'https://mcp.zoom.us/mcp/zoom/streamable'

/**
 * Zoom, through Zoom's own hosted MCP server (https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/).
 * Streamable HTTP, bearer token. Its protected-resource metadata (checked 20 Nov 2026) names
 * https://zoom.us as the authorization server, and that server's metadata allows the code flow with
 * PKCE S256 and client_secret_basic only. There is no dynamic client registration, so this is one
 * general OAuth app that Maskin owns (ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET in the Zoom Marketplace).
 *
 * Scopes are the four the transcript tools use: search_meetings, get_meeting_assets,
 * get_recording_resource and recordings_list. The server advertises more (Docs, Hub, chat search);
 * none of them are asked for, so those tools answer with a missing-scope error.
 *
 * A transcript exists only when the meeting was cloud recorded with the transcript on, or AI
 * Companion was on, and Zoom says a paid plan is needed. The description says so.
 *
 * Read-only is per agent and enforced by the gateway (GATEWAY_PROVIDERS): only the four tools above
 * count as reads (tool-kinds.ts), everything else is a write.
 */
export const config: ProviderConfig = {
	name: ZOOM_PROVIDER,
	displayName: 'Zoom',
	description:
		'Search meetings and read transcripts and summaries. Needs a paid Zoom plan, and a transcript only exists for a meeting that was cloud recorded with transcript on, or had AI Companion on.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://zoom.us/oauth/authorize',
			tokenUrl: 'https://zoom.us/oauth/token',
			revokeUrl: 'https://zoom.us/oauth/revoke',
			scopes: [
				'meeting:read:search',
				'meeting:read:assets',
				'cloud_recording:read:content',
				'cloud_recording:read:list_user_recordings',
			],
			pkce: true,
			tokenAuthMethod: 'client_secret_basic',
			clientIdEnv: 'ZOOM_CLIENT_ID',
			clientSecretEnv: 'ZOOM_CLIENT_SECRET',
		},
	},

	// No webhook or events block: meetings are searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', MCP_URL],
		envKey: 'ZOOM_TOKEN',
		server: {
			type: 'http',
			url: MCP_URL,
			headers: { Authorization: 'Bearer ${ZOOM_TOKEN}' },
		},
	},
}
