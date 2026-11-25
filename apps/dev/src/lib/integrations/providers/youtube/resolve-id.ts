import type { StoredCredentials } from '../../types'
import { resolveGoogleEmail } from '../_google/userinfo'

/**
 * Resolve the connected Google account's email as the integration's externalId.
 * Same as Meet and Calendar, so one Google account reads the same across providers.
 */
export const resolveExternalId = async (credentials: StoredCredentials): Promise<string> => {
	if (!credentials.accessToken) {
		throw new Error('Cannot resolve Google account email: no access token in credentials')
	}
	return resolveGoogleEmail(credentials.accessToken)
}
