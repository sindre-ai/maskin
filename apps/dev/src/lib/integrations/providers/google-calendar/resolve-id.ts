import type { StoredCredentials } from '../../types'

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
	const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
		headers: { Authorization: `Bearer ${credentials.accessToken}` },
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Failed to resolve Google Calendar email: HTTP ${res.status} ${text}`)
	}
	const data = (await res.json()) as { email?: string }
	if (!data.email) {
		throw new Error('Google Calendar userinfo response missing email field')
	}
	return data.email
}
