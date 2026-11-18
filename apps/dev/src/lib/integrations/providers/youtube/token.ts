import type { Database } from '@maskin/db'
import { IntegrationAuthRevokedError } from '../../errors'
import { getIntegrationCredential } from '../../lookup'
import { TokenManager } from '../../oauth/token-manager'
import { readContextFor } from '../../read-context'
import { getProvider } from '../../registry'
import { YoutubeError } from './errors'
import { purgeYoutubeData } from './purge'

export const YOUTUBE_PROVIDER = 'youtube'

const RECONNECT_HINT = 'Ask a workspace member to reconnect YouTube in Settings → Integrations.'

/**
 * Resolve the workspace's active YouTube integration id. YouTube is workspace-scoped (not in
 * actorScopedProviders), so one connected row covers every agent. The read goes through the
 * Keychain (scope check plus one credential_access_log row) and is attributed to the authenticated
 * caller; no caller, no read. Active rows only, so a revoked row never resolves.
 */
export async function getYoutubeIntegrationId(
	db: Database,
	workspaceId: string,
	requestingActorId: string,
): Promise<string> {
	if (!requestingActorId) {
		throw new YoutubeError({
			code: 'PERMISSION_DENIED',
			message: 'YouTube credentials are only read on behalf of an authenticated actor.',
			hint: 'Call this tool through the authenticated YouTube MCP route.',
		})
	}
	const integration = await getIntegrationCredential(db, workspaceId, YOUTUBE_PROVIDER, null, {
		ctx: readContextFor(requestingActorId, 'www.googleapis.com'),
	})
	if (!integration) {
		throw new YoutubeError({
			code: 'NOT_CONNECTED',
			message: 'No connected YouTube integration for this workspace.',
			hint: 'Ask a workspace member to connect YouTube in Settings → Integrations.',
		})
	}
	return integration.id
}

/**
 * A valid access token for the integration, refreshed if it is about to expire. A refresh that
 * Google answers with invalid_grant flips the row to revoked inside TokenManager; here it becomes
 * RECONSENT_REQUIRED, and the YouTube data we hold is purged (the person revoked on Google's side).
 * getProvider throws on an unregistered provider, and that throw is left
 * loud on purpose: it must not be mistaken for a revoked grant.
 */
export async function getYoutubeAccessToken(
	db: Database,
	integrationId: string,
	workspaceId: string,
): Promise<string> {
	const provider = getProvider(YOUTUBE_PROVIDER)
	try {
		return await new TokenManager().getValidToken(db, integrationId, provider)
	} catch (err) {
		if (err instanceof IntegrationAuthRevokedError) {
			await purgeYoutubeData(db, { integrationId, workspaceId })
			throw new YoutubeError({
				code: 'RECONSENT_REQUIRED',
				message: 'The connected YouTube grant was revoked and must be reconnected.',
				provider_status: 401,
				integration_id: integrationId,
				hint: RECONNECT_HINT,
			})
		}
		throw err
	}
}
