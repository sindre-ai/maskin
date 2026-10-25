import type { Database } from '@maskin/db'
import { IntegrationAuthRevokedError, ScopeDeniedError } from '../../errors'
import { getIntegrationCredential } from '../../lookup'
import { TokenManager } from '../../oauth/token-manager'
import { readContextFor } from '../../read-context'
import { getProvider } from '../../registry'
import { DriveError } from './errors'

export const GOOGLE_DRIVE_PROVIDER = 'google-drive'

/** Host recorded on the credential audit row for every Drive read. */
const DRIVE_OUTBOUND_TARGET = 'www.googleapis.com'

/**
 * Resolve a live Google Drive access token for the caller's workspace.
 *
 * Isolation (S8): the lookup is keyed on the workspace id from the verified
 * request, never on anything the agent supplies, and Drive is workspace-scoped
 * (not on actorScopedProviders) so it matches exactly the one active row with
 * actor_id NULL in that workspace. A caller in workspace B cannot resolve
 * workspace A's row.
 *
 * The read is gated and audited first (agent grant check, one credential
 * access log row, attributed to the authenticated caller). The token itself
 * still comes from the generic TokenManager, so refresh, rotation and the
 * invalid_grant -> revoked flip (which drives the needs-reconnect banner) are
 * the shared path, not a copy.
 *
 *   - No active row -> INTEGRATION_MISSING.
 *   - Caller holds no grant on the credential -> PERMISSION_DENIED.
 *   - invalid_grant on refresh -> RECONSENT_REQUIRED (TokenManager has already
 *     flipped the row).
 *   - Provider not registered -> thrown as-is so a registry gap is loud.
 */
export async function getGoogleDriveAccessToken(
	db: Database,
	workspaceId: string,
	requestingActorId: string,
): Promise<{ accessToken: string; integrationId: string }> {
	const integration = await getIntegrationCredential(db, workspaceId, GOOGLE_DRIVE_PROVIDER, null, {
		ctx: readContextFor(requestingActorId, DRIVE_OUTBOUND_TARGET),
	}).catch((err: unknown) => {
		if (err instanceof ScopeDeniedError) {
			throw new DriveError({
				code: 'PERMISSION_DENIED',
				message: 'This agent has not been granted access to the connected Google Drive.',
				hint: 'A workspace admin can grant access under Settings → Integrations.',
			})
		}
		throw err
	})
	if (!integration) {
		throw new DriveError({
			code: 'INTEGRATION_MISSING',
			message: 'No active Google Drive integration is connected on this workspace.',
			hint: 'Connect Google Drive under Settings → Integrations before calling this tool.',
		})
	}

	const provider = getProvider(GOOGLE_DRIVE_PROVIDER)
	try {
		const accessToken = await new TokenManager().getValidToken(db, integration.id, provider)
		return { accessToken, integrationId: integration.id }
	} catch (err) {
		if (err instanceof IntegrationAuthRevokedError) {
			throw new DriveError({
				code: 'RECONSENT_REQUIRED',
				message: 'The connected Google Drive grant was revoked and must be reconnected.',
				provider_status: 401,
				hint: 'Ask a workspace member to reconnect Google Drive in Settings → Integrations.',
			})
		}
		throw err
	}
}
