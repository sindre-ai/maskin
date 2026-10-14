import type { StoredCredentials } from '../../types'
import { resolveGoogleEmail } from '../_google/userinfo'

/**
 * Resolve the connected Google account's email as the integration's
 * externalId, the same identity string Gmail, Google Calendar and Meet use.
 */
export const resolveExternalId = async (credentials: StoredCredentials): Promise<string> => {
	if (!credentials.accessToken) {
		throw new Error('Cannot resolve Google account email: no access token in credentials')
	}
	return resolveGoogleEmail(credentials.accessToken)
}
