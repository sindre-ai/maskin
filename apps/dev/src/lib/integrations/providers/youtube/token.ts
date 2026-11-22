import type { Database } from '@maskin/db'
import { IntegrationAuthRevokedError } from '../../errors'
import { getCredential, getIntegrationCredential } from '../../lookup'
import { TokenManager } from '../../oauth/token-manager'
import { readContextFor } from '../../read-context'
import { getProvider } from '../../registry'
import { YOUTUBE_PROVIDER, listYoutubeConnections } from './connections'
import { YoutubeError } from './errors'
import { purgeYoutubeData } from './purge'

export { YOUTUBE_PROVIDER }

const RECONNECT_HINT = 'Ask a workspace member to reconnect YouTube in Settings → Integrations.'

/**
 * Resolve which active YouTube integration a call means. YouTube is workspace-scoped (not in
 * actorScopedProviders), so every connected Google account is a row any agent may use, as far as
 * its own access grant allows. The credential read goes through the Keychain (scope check plus one
 * credential_access_log row) and is attributed to the authenticated caller; no caller, no read.
 * Active rows only, so a revoked row never resolves.
 *
 * Which row:
 *  - requestedId given: that row, if it is one of this workspace's active connections;
 *  - none given and one connection: that one, as before several channels existed;
 *  - none given and several: INTEGRATION_REQUIRED, listing the connections. Nothing is guessed,
 *    so one channel's numbers are never returned for another channel's question.
 */
export async function getYoutubeIntegrationId(
	db: Database,
	workspaceId: string,
	requestingActorId: string,
	requestedId?: string,
): Promise<string> {
	if (!requestingActorId) {
		throw new YoutubeError({
			code: 'PERMISSION_DENIED',
			message: 'YouTube credentials are only read on behalf of an authenticated actor.',
			hint: 'Call this tool through the authenticated YouTube MCP route.',
		})
	}
	const connections = await listYoutubeConnections(db, workspaceId)
	const ctx = readContextFor(requestingActorId, 'www.googleapis.com')

	if (requestedId) {
		if (!connections.some((c) => c.integration_id === requestedId)) {
			throw new YoutubeError({
				code: 'INTEGRATION_REQUIRED',
				message: 'That integration id is not an active YouTube connection in this workspace.',
				hint: 'Pass one of the listed integration ids, or leave it out if only one is connected.',
				connections,
			})
		}
		const credential = await getCredential(db, workspaceId, requestedId, ctx)
		return credential.id
	}

	if (connections.length > 1) {
		throw new YoutubeError({
			code: 'INTEGRATION_REQUIRED',
			message: 'Several YouTube accounts are connected. Say which one with integration_id.',
			hint: 'Ask the person which channel they mean, or pass the integration_id of one connection below. Numbers from different channels are never combined.',
			connections,
		})
	}

	const integration = await getIntegrationCredential(db, workspaceId, YOUTUBE_PROVIDER, null, {
		ctx,
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
