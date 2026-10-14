import type { Database } from '@maskin/db'
import { actors, oauthGrants, oauthTokens } from '@maskin/db/schema'
import { OAUTH_ACCESS_TOKEN_PREFIX, type OauthAccessTokenContext } from '@maskin/shared'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { sha256Hex } from './token-hash'

/**
 * Resolves a raw mat_ access token to the person and the one workspace it is pinned to,
 * or null. One query: the token row joined to its grant and actor, by hash. Refresh
 * tokens, revoked or expired tokens and revoked grants never resolve.
 *
 * Whether the person is still a member of the pinned workspace is not checked here; the
 * caller does that on every request.
 */
export async function validateOAuthAccessToken(
	db: Database,
	rawToken: string,
): Promise<OauthAccessTokenContext | null> {
	if (!rawToken.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return null

	const now = new Date()
	const [row] = await db
		.select({
			actorId: oauthGrants.actorId,
			type: actors.type,
			workspaceId: oauthGrants.workspaceId,
			grantId: oauthGrants.id,
			clientId: oauthGrants.clientId,
			scope: oauthGrants.scope,
			resource: oauthGrants.resource,
			expiresAt: oauthTokens.expiresAt,
		})
		.from(oauthTokens)
		.innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
		.innerJoin(actors, eq(actors.id, oauthGrants.actorId))
		.where(
			and(
				eq(oauthTokens.tokenHash, sha256Hex(rawToken)),
				eq(oauthTokens.kind, 'access'),
				isNull(oauthTokens.revokedAt),
				gt(oauthTokens.expiresAt, now),
				isNull(oauthGrants.revokedAt),
			),
		)
		.limit(1)

	return row ?? null
}
