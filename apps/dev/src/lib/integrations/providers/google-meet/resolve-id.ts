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
 * Fetch the caller's Google People id via `people.get(me)`.
 *
 * The Workspace Events subscription Task 3 creates targets
 * `//cloudidentity.googleapis.com/users/{peopleId}` — that string is built
 * from `config.meet.peopleId` stored here at OAuth callback. Deliveries
 * carry the People-id (not the email) as the resource reference; the
 * webhook fan-out looks the row up by matching this stored id.
 *
 * Scopes: `openid` alone grants `people.get(me)` — no `directory.readonly`
 * needed (CTO 2026-09-10 deferral; see Reshape §4.1 addendum / S12 smoke).
 *
 * Shape: the response's `metadata.sources[]` array contains one entry per
 * source that populated the profile. The first entry's `id` is the stable
 * People id (a numeric string that never changes for a Google account) —
 * that is what the Workspace Events API expects at
 * `targetResource=//cloudidentity.googleapis.com/users/{id}`.
 */
export async function resolveMeetPeopleId(accessToken: string): Promise<string> {
	const res = await fetch('https://people.googleapis.com/v1/people/me?personFields=metadata', {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Failed to resolve Google People id: HTTP ${res.status} ${text}`)
	}
	const data = (await res.json()) as {
		metadata?: { sources?: Array<{ id?: string }> }
	}
	const peopleId = data.metadata?.sources?.[0]?.id
	if (!peopleId) {
		throw new Error('Google People response missing metadata.sources[0].id')
	}
	return peopleId
}
