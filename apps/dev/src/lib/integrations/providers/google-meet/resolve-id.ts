import { logger } from '../../../logger'
import type { StoredCredentials } from '../../types'
import { resolveGoogleEmail } from '../_google/userinfo'

/**
 * Resolve the connected Google account's email as the integration's
 * externalId. Mirrors Gmail and Google Calendar so a single Google host
 * connects across all three providers under the same identity string.
 *
 * Webhook routing: Task 3's `webhookPreHandler` maps the People-id carried on
 * a Workspace Events push to this email at delivery time (via
 * `config.meet.peopleId`), so the generic route's
 * `WHERE external_id=installationId` join still holds.
 */
export const resolveExternalId = async (credentials: StoredCredentials): Promise<string> => {
	if (!credentials.accessToken) {
		throw new Error('Cannot resolve Google account email: no access token in credentials')
	}
	return resolveGoogleEmail(credentials.accessToken)
}

/**
 * Resolve the caller's stable Google account id (the "People id").
 *
 * The Workspace Events subscription Task 3 creates targets
 * `//cloudidentity.googleapis.com/users/{peopleId}` — that string is built
 * from `config.meet.peopleId` stored here at OAuth callback. Deliveries
 * carry the People-id (not the email) as the resource reference; the
 * webhook fan-out looks the row up by matching this stored id.
 *
 * Read from the OAuth userinfo endpoint's `id` (the OIDC `sub`), which is the
 * same numeric id `people/me` reports in `metadata.sources[].id`. We do NOT
 * call the People API: it is a separate Cloud API that has to be enabled in
 * the OAuth client's project, and in prod it was not — Google answered 403
 * `SERVICE_DISABLED` (Sentry MASKIN-DEV-11), which no scope can fix. Userinfo
 * needs nothing beyond the `openid` + `userinfo.email` scopes already granted.
 */
export async function resolveMeetPeopleId(accessToken: string): Promise<string> {
	const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	if (!res.ok) {
		const text = await res.text()
		logger.warn('Google userinfo call failed while resolving People id', {
			httpStatus: res.status,
			body: text.slice(0, 2000),
		})
		throw new Error(`Failed to resolve Google People id: HTTP ${res.status} ${text}`)
	}
	const data = (await res.json()) as { id?: string }
	if (!data.id) {
		throw new Error('Google userinfo response missing id field')
	}
	return data.id
}
