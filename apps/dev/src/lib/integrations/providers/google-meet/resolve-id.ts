import type { StoredCredentials } from '../../types'
import { resolveGoogleEmail } from '../_google/userinfo'

/**
 * COMPILE-CARRY STUB — Task 2 territory
 *
 * Task 2 owns the full OAuth-callback path including the People-id fetch
 * (people.get(me).metadata.sources[0].id) that gets persisted to
 * config.meet.peopleId. This helper is limited to the external_id resolution
 * (host Google email) so the registry has something to bind.
 */
export const resolveExternalId = async (credentials: StoredCredentials): Promise<string> => {
	if (!credentials.accessToken) {
		throw new Error('Cannot resolve Google Meet host email: no access token in credentials')
	}
	return resolveGoogleEmail(credentials.accessToken)
}
