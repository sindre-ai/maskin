import type { Database } from '@maskin/db'
import { IntegrationAuthRevokedError } from '../../errors'
import { getIntegrationCredential } from '../../lookup'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'
import { MeetError } from './errors'

/**
 * Provider slug for the Google Meet integration. Wired by Task 2's
 * providers.set('google-meet', ...) call in registry.ts — this file does NOT
 * register the provider (Task 2 owns config.ts + registry.ts). We depend on
 * that registration only at runtime, via `getProvider(...)`.
 */
export const GOOGLE_MEET_PROVIDER = 'google-meet'

/**
 * Resolves the caller-actor's Google Meet access token for the write path.
 *
 * Meet is workspace-scoped (per Reshape tech spec §2 — not on the
 * actorScopedProviders allow-list), so a single connected Meet row per
 * workspace covers every agent. When the task 824f1a6a "Actor-token
 * resolution" ladder resolves to a specific actor (explicit actor_id →
 * meeting_owner → GCal organiser → caller actor), we pass the actor id
 * through, but because Meet isn't actor-scoped, `getIntegrationCredential`
 * returns the workspace-scoped row regardless. This keeps the call site
 * ready for the day the bet flips to multi-host (add `'google-meet'` to
 * `actorScopedProviders`) without a caller-code rewrite.
 *
 * Terminal outcomes:
 *   - No row / row not `active` → `MeetError.RECONSENT_REQUIRED`.
 *     The write path can't succeed without a live Google grant; asking the
 *     caller to prompt reconnect is the only remedy.
 *   - `IntegrationAuthRevokedError` on refresh (invalid_grant) → same class.
 *     TokenManager flips the row to `revoked`; the actor must reconnect.
 *   - Provider not registered (Task 2's registry line hasn't merged into the
 *     branch this code runs on) → thrown as a plain Error so the failure is
 *     loud in dev logs / CI and NOT silently mapped to RECONSENT_REQUIRED,
 *     which would send a customer down the wrong path.
 */
export async function getGoogleMeetAccessToken(
	db: Database,
	workspaceId: string,
	actorId: string | null,
): Promise<{ accessToken: string; integrationId: string }> {
	const integration = await getIntegrationCredential(
		db,
		workspaceId,
		GOOGLE_MEET_PROVIDER,
		actorId,
	)
	if (!integration) {
		throw new MeetError({
			code: 'RECONSENT_REQUIRED',
			message: 'No connected Google Meet integration for this workspace.',
			provider_status: 0,
			hint: 'Ask a workspace member to connect Google Meet in Settings → Integrations.',
		})
	}

	// getProvider throws on unknown providers — see registry.ts:127. We surface
	// that throw as-is so a merge-order gap (write-path merged before Task 2's
	// provider registration) can't quietly land as a RECONSENT_REQUIRED to the
	// customer. Loud in tests, loud in CI, loud in dev.
	const provider = getProvider(GOOGLE_MEET_PROVIDER)

	const tokenManager = new TokenManager()
	try {
		const accessToken = await tokenManager.getValidToken(db, integration.id, provider)
		return { accessToken, integrationId: integration.id }
	} catch (err) {
		if (err instanceof IntegrationAuthRevokedError) {
			throw new MeetError({
				code: 'RECONSENT_REQUIRED',
				message: 'The connected Google Meet grant was revoked and must be reconnected.',
				provider_status: 401,
				hint: 'Ask the actor who connected Google Meet to reconnect it in Settings → Integrations.',
			})
		}
		throw err
	}
}
