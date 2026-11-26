import type { ProviderConfig } from '../../types'

/**
 * Apollo, through its hosted MCP server (https://mcp.apollo.io/mcp). Its sign-in details are
 * from its published metadata at /.well-known/oauth-authorization-server (checked 20 Nov 2026,
 * issuer https://mcp.apollo.io).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/apollo/callback` on
 * each public origin) through Apollo's open registration (RFC 7591, client_secret_basic,
 * client_secret_post or none; CIMD too), with scripts/register-oauth-client.mjs; its id and
 * secret live in APOLLO_CLIENT_ID and APOLLO_CLIENT_SECRET.
 *
 * Apollo publishes about 90 scopes. Only the read ones are asked for (searching, enriching,
 * reading contacts, accounts, deals, sequences and calls). Nothing that writes, sends mail,
 * runs a sequence or buys a domain or mailbox is asked for, so those tools answer with a
 * missing-scope error until a person widens this list. Enrichment tools read data but spend the
 * customer's Apollo credits. A separate login that one agent already holds for Apollo (a saved
 * key or sign-in, not this provider) is not touched here.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'apollo',
	displayName: 'Apollo',
	description:
		'Search Apollo people and companies and read contacts, accounts and sequences. Enrichment spends your Apollo credits.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.apollo.io/mcp/oauth_metadata/redirect_to_authorize',
			tokenUrl: 'https://mcp.apollo.io/api/v1/oauth/token',
			revokeUrl: 'https://mcp.apollo.io/api/v1/oauth/revoke',
			scopes: [
				'read_user_profile',
				'app_scopes',
				'mcp_scope',
				'people_match',
				'people_bulk_match',
				'organizations_enrich',
				'organizations_bulk_enrich',
				'mixed_people_api_search',
				'mixed_companies_search',
				'organizations_search',
				'organizations_job_posting',
				'contacts_search',
				'contact_read',
				'contact_stages_list',
				'accounts_search',
				'account_stages_list',
				'opportunities_list',
				'opportunity_read',
				'tasks_list',
				'tags_list',
				'users_list',
				'custom_fields_list',
				'custom_objects_read',
				'emailer_campaigns_search',
				'emailer_campaign_read',
				'emailer_campaigns_activity_feed',
				'emailer_schedules_list',
				'emailer_messages_search',
				'emailer_messages_get_content',
				'emailer_messages_email_send_status',
				'email_accounts_list',
				'phone_call_search',
				'conversation_intelligence_search',
				'conversation_intelligence_show',
				'context_center_read',
				'website_visitors_read',
				'api_usage_stats_read',
				'credit_usage_stats_read',
			],
			pkce: true,
			clientIdEnv: 'APOLLO_CLIENT_ID',
			clientSecretEnv: 'APOLLO_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.apollo.io/mcp'],
		envKey: 'APOLLO_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.apollo.io/mcp',
			headers: { Authorization: 'Bearer ${APOLLO_TOKEN}' },
		},
	},
}
