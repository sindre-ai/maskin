import type { ProviderConfig } from '../../types'

/**
 * linkedin-unipile provider config.
 *
 * Registered in the integration registry so it shows up in
 * GET /api/integrations/providers (which the Settings > Integrations page
 * reads via `list_integration_providers`). The actual connect + callback
 * routes live in `apps/dev/src/routes/integrations-linkedin-unipile.ts`
 * because the Unipile Hosted Auth Wizard is NOT OAuth2 — see spec §2.
 *
 * `auth.type = 'oauth2_custom'` is a sentinel here: it keeps the provider
 * out of the generic OAuth2 handler's path (which would try to build an
 * authorization URL) while still satisfying ProviderConfig's discriminated
 * union. The generic /{provider}/connect handler explicitly early-returns
 * for this provider name and directs the caller to the dedicated route.
 */
export const config: ProviderConfig = {
	name: 'linkedin-unipile',
	displayName: 'LinkedIn',
	description:
		'Send LinkedIn DMs and read conversations on behalf of the connected member via Unipile.',

	auth: {
		type: 'oauth2_custom',
	},

	externalIdDisplay: 'installation',
}
