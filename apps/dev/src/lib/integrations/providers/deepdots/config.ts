import type { ProviderConfig } from '../../types'

/**
 * Deepdots (also MagicFeedback) hands out a one-hour token in exchange for an
 * email and a password, so it cannot use the one-saved-key path. A person
 * connects from a two-field form (routes/integrations-deepdots.ts); the stored
 * login is what keeps the token renewed (./auth.ts).
 *
 * `auth.type = 'oauth2_custom'` is a sentinel, the same way it is for
 * linkedin-unipile: it makes TokenManager use `customAuth` for renewal while the
 * connect route lives outside the generic OAuth one. The generic connect route
 * must not run for this provider.
 */
export const config: ProviderConfig = {
	name: 'deepdots',
	displayName: 'Deepdots',
	description: 'Customer feedback insights, issues and opportunities from Deepdots (read only)',

	auth: { type: 'oauth2_custom' },

	externalIdDisplay: 'email',
}
