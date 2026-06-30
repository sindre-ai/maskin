import type { StoredCredentials } from '../../types'
import { resolveGoogleEmail } from '../_google/userinfo'

/**
 * Resolve the connected Google account's email address as the integration's
 * externalId. Stable per Google account and human-readable in the admin UI.
 *
 * T2 webhook-routing constraint: Google Calendar HTTP push notifications
 * (calendar.events.watch) carry X-Goog-Channel-ID in headers and no email in
 * the body. The generic webhook route looks up integrations by
 * `external_id = installationId`. T2's postInstall hook MUST update
 * `external_id` to the push channel ID it registers (e.g. the integration row
 * ID), so the lookup matches. Do NOT rely on the email surviving as the
 * production externalId past T1.
 */
export const resolveExternalId = async (credentials: StoredCredentials): Promise<string> => {
	return resolveGoogleEmail(credentials.accessToken ?? '')
}
