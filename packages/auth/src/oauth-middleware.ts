import type { Database } from '@maskin/db'
import { oauthGrants, workspaceMembers } from '@maskin/db/schema'
import { createApiError } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import type { Context, Next } from 'hono'
import { matchedRoutes } from 'hono/route'
import type { AuthCaches } from './auth-cache'
import { MCP_FORWARD_HEADER, isValidMcpForwardMarker } from './forward-marker'
import { resolveMcpCredential } from './mcp-credential'
import { runWithOAuthPin } from './oauth-pin'
import { isOAuthRequestAllowed } from './oauth-route-allowlist'
import { validateOAuthAccessToken } from './oauth-token'
import { sha256Hex } from './token-hash'

const WORKSPACE_HEADER = 'X-Workspace-Id'
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000
const lastUsedWrittenAt = new Map<string, number>()
const MAX_TRACKED_GRANTS = 5_000

function invalidToken(c: Context) {
	c.header('WWW-Authenticate', 'Bearer error="invalid_token"')
	return c.json(
		createApiError(
			'UNAUTHORIZED',
			'Invalid token',
			undefined,
			'Reconnect Maskin in your Claude connector settings',
		),
		401,
	)
}

/**
 * The mat_ branch of authMiddleware (Claude connector access tokens).
 *
 * A mat_ token resolves to the person who approved the connection and to exactly one
 * workspace, the one on the grant. Four things keep it there:
 *  1. it is only accepted with the per-process forward marker the /mcp route adds, so it
 *     works through /mcp and nowhere else;
 *  2. it reaches only the routes on the allowlist (oauth-route-allowlist.ts);
 *  3. X-Workspace-Id is taken from the grant: a different value is refused, a missing one
 *     is filled in, so routes that read the header can only ever see the pinned workspace;
 *  4. the rest of the request runs with the pin in scope (getOAuthPin), which the
 *     membership helpers and cross-workspace queries honour.
 */
export async function authenticateOAuthToken(
	c: Context,
	next: Next,
	deps: { db: Database; caches: AuthCaches },
	token: string,
): Promise<Response | undefined> {
	const { db, caches } = deps

	// Refresh tokens are not bearer credentials, and a request that did not come through
	// the /mcp forwarder looks exactly like a bad token.
	if (!token.startsWith('mat_') || !isValidMcpForwardMarker(c.req.header(MCP_FORWARD_HEADER))) {
		return invalidToken(c)
	}

	const credential = await resolveMcpCredential(db, token, {
		oauth: (raw) =>
			caches.oauthTokens.get(
				sha256Hex(raw),
				() => validateOAuthAccessToken(db, raw),
				(value) => value !== null,
			),
	})
	if (credential?.kind !== 'oauth') return invalidToken(c)

	if (!isOAuthRequestAllowed(matchedRoutes(c))) {
		c.header('WWW-Authenticate', 'Bearer error="insufficient_scope", scope="mcp"')
		return c.json(
			{
				error: {
					...createApiError('FORBIDDEN', 'This route is not available to a connected Claude client')
						.error,
					oauth_error: 'insufficient_scope',
				},
			},
			403,
		)
	}

	const pinned = credential.workspaceId
	const requested = c.req.header(WORKSPACE_HEADER)
	if (requested && requested.toLowerCase() !== pinned.toLowerCase()) {
		return c.json(
			{
				error: {
					...createApiError(
						'FORBIDDEN',
						'This connection is limited to the workspace it was approved for',
					).error,
					oauth_error: 'workspace_mismatch',
				},
			},
			403,
		)
	}

	// Membership is checked on every request, not only when a header is sent: removing the
	// person from the workspace must end the connection.
	const isMember = await caches.memberships.get(
		`${credential.actorId}|${pinned}`,
		async () => {
			const [member] = await db
				.select({ actorId: workspaceMembers.actorId })
				.from(workspaceMembers)
				.where(
					and(
						eq(workspaceMembers.actorId, credential.actorId),
						eq(workspaceMembers.workspaceId, pinned),
					),
				)
				.limit(1)
			return Boolean(member)
		},
		(value) => value,
	)
	if (!isMember) return invalidToken(c)

	c.set('actorId', credential.actorId)
	c.set('actorType', credential.actorType)
	// Routes that read the header must see the pinned workspace even if the client sent none.
	if (!requested) c.req.raw.headers.set(WORKSPACE_HEADER, pinned)

	touchGrant(db, credential.grantId)

	return runWithOAuthPin(
		{ workspaceId: pinned, grantId: credential.grantId, clientId: credential.clientId },
		() => next().then(() => undefined),
	)
}

/** Stamps oauth_grants.last_used_at at most once per 5 minutes per grant, off the request path. */
function touchGrant(db: Database, grantId: string) {
	const now = Date.now()
	const last = lastUsedWrittenAt.get(grantId)
	if (last !== undefined && now - last < LAST_USED_WRITE_INTERVAL_MS) return
	if (lastUsedWrittenAt.size >= MAX_TRACKED_GRANTS) lastUsedWrittenAt.clear()
	lastUsedWrittenAt.set(grantId, now)
	try {
		void Promise.resolve(
			db
				.update(oauthGrants)
				.set({ lastUsedAt: new Date(now) })
				.where(eq(oauthGrants.id, grantId)),
		).catch(() => lastUsedWrittenAt.delete(grantId))
	} catch {
		lastUsedWrittenAt.delete(grantId)
	}
}
