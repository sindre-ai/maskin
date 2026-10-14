import { evictOAuthTokens, mintToken, sha256Hex } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	oauthAuthorizationCodes,
	oauthGrants,
	oauthTokens,
	workspaceMembers,
} from '@maskin/db/schema'
import {
	OAUTH_ACCESS_TOKEN_PREFIX,
	OAUTH_ACCESS_TTL_S,
	OAUTH_REFRESH_TOKEN_PREFIX,
	OAUTH_REFRESH_TTL_S,
	OAUTH_SCOPE,
	type OauthTokenResponse,
} from '@maskin/shared'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { recordEvent } from '../events/record-event'
import { logger } from '../logger'
import {
	type TokenRejectedReason,
	captureRefreshReuseRevoked,
	captureTokenIssued,
	captureTokenRefreshed,
	captureTokenRejected,
} from './analytics'
import { isMcpResource, isPinnedClientId } from './authorize'
import { isGrantRefreshable, revokeGrant } from './grants'
import { verifyPkce } from './pkce'

// The token endpoint's logic (RFC 6749 section 4.1.3 and 6), kept apart from the Hono route so
// it can be tested against a real database. Every refusal is one of the RFC's error codes with a
// fixed description: nothing from the request is ever echoed back.

type TokenErrorCode =
	| 'invalid_request'
	| 'invalid_client'
	| 'invalid_grant'
	| 'unsupported_grant_type'
	| 'invalid_target'
	| 'invalid_scope'

export type TokenResult =
	| { ok: true; body: OauthTokenResponse }
	| { ok: false; status: 400; error: TokenErrorCode; description: string }

const DESCRIPTIONS: Record<TokenErrorCode, string> = {
	invalid_request: 'The request is missing a value or has a malformed one',
	invalid_client: 'This app is not on the list of apps Maskin has approved',
	invalid_grant: 'The code or refresh token is invalid, expired or already used',
	unsupported_grant_type: 'Only authorization_code and refresh_token are supported',
	invalid_target: 'The requested resource is not this server',
	invalid_scope: 'The requested scope is not supported',
}

const BODY_MAX_CHARS = 16_384

const authorizationCodeFormSchema = z.object({
	grant_type: z.literal('authorization_code'),
	code: z.string().min(1).max(256),
	redirect_uri: z.string().min(1).max(2048),
	code_verifier: z
		.string()
		.min(43)
		.max(128)
		.regex(/^[A-Za-z0-9\-._~]+$/),
	client_id: z.string().min(1).max(2048),
	resource: z.string().max(2048).optional(),
})

const refreshFormSchema = z.object({
	grant_type: z.literal('refresh_token'),
	refresh_token: z.string().min(1).max(256),
	client_id: z.string().min(1).max(2048),
	scope: z.string().max(256).optional(),
	resource: z.string().max(2048).optional(),
})

function failure(error: TokenErrorCode): TokenResult {
	return { ok: false, status: 400, error, description: DESCRIPTIONS[error] }
}

function refuse(
	error: TokenErrorCode,
	reason: TokenRejectedReason,
	context: { clientId?: string; actorId?: string; grantId?: string } = {},
): TokenResult {
	captureTokenRejected({ reason, ...context })
	return failure(error)
}

/**
 * Reads the form body. Returns null when it is not a well-formed form: too big, or a parameter
 * given twice (RFC 6749 section 3.2 says parameters must not repeat).
 */
export function parseTokenForm(raw: string): Record<string, string> | null {
	if (raw.length > BODY_MAX_CHARS) return null
	const form: Record<string, string> = {}
	for (const [key, value] of new URLSearchParams(raw)) {
		if (Object.hasOwn(form, key)) return null
		form[key] = value
	}
	return form
}

export async function handleTokenRequest(
	db: Database,
	form: Record<string, string>,
	now: Date = new Date(),
): Promise<TokenResult> {
	if (form.grant_type === 'authorization_code') {
		const parsed = authorizationCodeFormSchema.safeParse(form)
		if (!parsed.success) return refuse('invalid_request', 'invalid_request')
		return exchangeAuthorizationCode(db, parsed.data, now)
	}
	if (form.grant_type === 'refresh_token') {
		const parsed = refreshFormSchema.safeParse(form)
		if (!parsed.success) return refuse('invalid_request', 'invalid_request')
		return refreshTokens(db, parsed.data, now)
	}
	return refuse('unsupported_grant_type', 'unsupported_grant_type')
}

function tokenBody(access: string, refresh: string, scope: string): OauthTokenResponse {
	return {
		access_token: access,
		token_type: 'Bearer',
		expires_in: OAUTH_ACCESS_TTL_S,
		refresh_token: refresh,
		scope,
	}
}

async function isMember(db: Pick<Database, 'select'>, actorId: string, workspaceId: string) {
	const [row] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(eq(workspaceMembers.actorId, actorId), eq(workspaceMembers.workspaceId, workspaceId)),
		)
		.limit(1)
	return Boolean(row)
}

export async function exchangeAuthorizationCode(
	db: Database,
	p: z.infer<typeof authorizationCodeFormSchema>,
	now: Date = new Date(),
): Promise<TokenResult> {
	if (!isPinnedClientId(p.client_id)) return refuse('invalid_client', 'invalid_request')
	if (p.resource !== undefined && !isMcpResource(p.resource)) {
		return refuse('invalid_target', 'resource_mismatch', { clientId: p.client_id })
	}

	const codeHash = sha256Hex(p.code)

	// One statement, so of two simultaneous presentations exactly one gets the row.
	const [consumed] = await db
		.update(oauthAuthorizationCodes)
		.set({ consumedAt: now })
		.where(
			and(
				eq(oauthAuthorizationCodes.codeHash, codeHash),
				isNull(oauthAuthorizationCodes.consumedAt),
				gt(oauthAuthorizationCodes.expiresAt, now),
			),
		)
		.returning({
			grantId: oauthAuthorizationCodes.grantId,
			redirectUri: oauthAuthorizationCodes.redirectUri,
			codeChallenge: oauthAuthorizationCodes.codeChallenge,
		})

	if (!consumed) {
		const [seen] = await db
			.select({
				grantId: oauthAuthorizationCodes.grantId,
				consumedAt: oauthAuthorizationCodes.consumedAt,
			})
			.from(oauthAuthorizationCodes)
			.where(eq(oauthAuthorizationCodes.codeHash, codeHash))
			.limit(1)
		if (!seen?.consumedAt) {
			return refuse('invalid_grant', 'code_unknown_or_expired', { clientId: p.client_id })
		}
		// Replay of a code that was already used: the person's connection may be in the wrong hands.
		const [grant] = await db
			.select({ actorId: oauthGrants.actorId, workspaceId: oauthGrants.workspaceId })
			.from(oauthGrants)
			.where(eq(oauthGrants.id, seen.grantId))
			.limit(1)
		const revoked = await db.transaction(async (tx) => {
			const done = await revokeGrant(tx, {
				grantId: seen.grantId,
				reason: 'code_reuse',
				byActorId: null,
			})
			if (done && grant) {
				await recordEvent(tx, {
					workspaceId: grant.workspaceId,
					actorId: grant.actorId,
					action: 'oauth_code_reuse_detected',
					entityType: 'oauth_grant',
					entityId: seen.grantId,
					data: { grant_id: seen.grantId },
				})
			}
			return done
		})
		if (revoked) evictOAuthTokens()
		logger.warn('OAuth authorization code presented twice, grant revoked', {
			grantId: seen.grantId,
		})
		return refuse('invalid_grant', 'code_reuse', {
			clientId: p.client_id,
			actorId: grant?.actorId,
			grantId: seen.grantId,
		})
	}

	const [grant] = await db
		.select()
		.from(oauthGrants)
		.where(eq(oauthGrants.id, consumed.grantId))
		.limit(1)
	const member = grant ? await isMember(db, grant.actorId, grant.workspaceId) : false
	if (!grant || grant.revokedAt !== null || grant.clientId !== p.client_id || !member) {
		return refuse('invalid_grant', 'code_unknown_or_expired', {
			clientId: p.client_id,
			actorId: grant?.actorId,
			grantId: grant?.id,
		})
	}
	const context = { clientId: p.client_id, actorId: grant.actorId, grantId: grant.id }
	if (consumed.redirectUri !== p.redirect_uri) {
		return refuse('invalid_grant', 'redirect_mismatch', context)
	}
	if (!verifyPkce(p.code_verifier, consumed.codeChallenge)) {
		const revoked = await db.transaction((tx) =>
			revokeGrant(tx, { grantId: grant.id, reason: 'pkce_failure', byActorId: null }),
		)
		if (revoked) evictOAuthTokens()
		return refuse('invalid_grant', 'pkce_failed', context)
	}

	const access = mintToken(OAUTH_ACCESS_TOKEN_PREFIX)
	const refresh = mintToken(OAUTH_REFRESH_TOKEN_PREFIX)
	await db.transaction(async (tx) => {
		await tx.insert(oauthTokens).values([
			{
				grantId: grant.id,
				kind: 'access',
				tokenHash: access.hash,
				expiresAt: new Date(now.getTime() + OAUTH_ACCESS_TTL_S * 1000),
			},
			{
				grantId: grant.id,
				kind: 'refresh',
				tokenHash: refresh.hash,
				expiresAt: new Date(now.getTime() + OAUTH_REFRESH_TTL_S * 1000),
			},
		])
		await recordEvent(tx, {
			workspaceId: grant.workspaceId,
			actorId: grant.actorId,
			action: 'oauth_token_issued',
			entityType: 'oauth_grant',
			entityId: grant.id,
			data: { grant_id: grant.id, via: 'authorization_code' },
		})
	})
	captureTokenIssued({
		actorId: grant.actorId,
		clientId: p.client_id,
		workspaceId: grant.workspaceId,
		grantId: grant.id,
	})
	return { ok: true, body: tokenBody(access.raw, refresh.raw, grant.scope) }
}

type RefreshOutcome =
	| { kind: 'ok'; body: OauthTokenResponse; actorId: string; workspaceId: string; grantId: string }
	| { kind: 'refused'; result: TokenResult }
	| {
			kind: 'reuse'
			actorId: string
			workspaceId: string
			grantId: string
			grantAgeSeconds: number
			secondsSinceFirstUse: number
	  }

export async function refreshTokens(
	db: Database,
	p: z.infer<typeof refreshFormSchema>,
	now: Date = new Date(),
): Promise<TokenResult> {
	if (!isPinnedClientId(p.client_id)) return refuse('invalid_client', 'invalid_request')
	if (p.resource !== undefined && !isMcpResource(p.resource)) {
		return refuse('invalid_target', 'resource_mismatch', { clientId: p.client_id })
	}
	if (p.scope !== undefined) {
		const tokens = p.scope.split(/\s+/).filter(Boolean)
		if (!tokens.every((token) => token === OAUTH_SCOPE)) {
			return refuse('invalid_scope', 'invalid_request', { clientId: p.client_id })
		}
	}

	const tokenHash = sha256Hex(p.refresh_token)
	const outcome = await db.transaction(async (tx): Promise<RefreshOutcome> => {
		// Locked, so two simultaneous refreshes of one token cannot both rotate it.
		const [token] = await tx
			.select()
			.from(oauthTokens)
			.where(and(eq(oauthTokens.tokenHash, tokenHash), eq(oauthTokens.kind, 'refresh')))
			.for('update')
			.limit(1)
		if (!token) {
			return {
				kind: 'refused',
				result: refuse('invalid_grant', 'refresh_unknown_or_expired', { clientId: p.client_id }),
			}
		}
		const [grant] = await tx
			.select()
			.from(oauthGrants)
			.where(eq(oauthGrants.id, token.grantId))
			.limit(1)
		if (!grant) {
			return {
				kind: 'refused',
				result: refuse('invalid_grant', 'refresh_unknown_or_expired', { clientId: p.client_id }),
			}
		}
		const context = { clientId: p.client_id, actorId: grant.actorId, grantId: grant.id }

		// A refresh token used before is theft or a lost response. No grace window: the whole
		// connection ends and the person reconnects.
		if (token.usedAt !== null && grant.revokedAt === null) {
			await revokeGrant(tx, { grantId: grant.id, reason: 'refresh_reuse', byActorId: null })
			await recordEvent(tx, {
				workspaceId: grant.workspaceId,
				actorId: grant.actorId,
				action: 'oauth_refresh_reuse_detected',
				entityType: 'oauth_grant',
				entityId: grant.id,
				data: { grant_id: grant.id },
			})
			return {
				kind: 'reuse',
				actorId: grant.actorId,
				workspaceId: grant.workspaceId,
				grantId: grant.id,
				grantAgeSeconds: Math.max(
					0,
					Math.round((now.getTime() - grant.createdAt.getTime()) / 1000),
				),
				secondsSinceFirstUse: Math.max(
					0,
					Math.round((now.getTime() - token.usedAt.getTime()) / 1000),
				),
			}
		}

		const member = await isMember(tx, grant.actorId, grant.workspaceId)
		if (
			grant.clientId !== p.client_id ||
			!isGrantRefreshable(
				{ grantRevokedAt: grant.revokedAt, refreshToken: token, isMember: member },
				now,
			)
		) {
			// Ended on purpose (revoked, or the person left) versus simply too old or another client's.
			const ended = grant.revokedAt !== null || token.revokedAt !== null || !member
			const reason = ended ? 'refresh_revoked' : 'refresh_unknown_or_expired'
			return { kind: 'refused', result: refuse('invalid_grant', reason, context) }
		}

		const access = mintToken(OAUTH_ACCESS_TOKEN_PREFIX)
		const refresh = mintToken(OAUTH_REFRESH_TOKEN_PREFIX)
		const [next] = await tx
			.insert(oauthTokens)
			.values({
				grantId: grant.id,
				kind: 'refresh',
				tokenHash: refresh.hash,
				expiresAt: new Date(now.getTime() + OAUTH_REFRESH_TTL_S * 1000),
			})
			.returning({ id: oauthTokens.id })
		if (!next) throw new Error('Failed to insert the rotated refresh token')
		await tx
			.update(oauthTokens)
			.set({ usedAt: now, replacedBy: next.id })
			.where(eq(oauthTokens.id, token.id))
		await tx.insert(oauthTokens).values({
			grantId: grant.id,
			kind: 'access',
			tokenHash: access.hash,
			expiresAt: new Date(now.getTime() + OAUTH_ACCESS_TTL_S * 1000),
		})
		await recordEvent(tx, {
			workspaceId: grant.workspaceId,
			actorId: grant.actorId,
			action: 'oauth_token_refreshed',
			entityType: 'oauth_grant',
			entityId: grant.id,
			data: { grant_id: grant.id },
		})
		return {
			kind: 'ok',
			body: tokenBody(access.raw, refresh.raw, grant.scope),
			actorId: grant.actorId,
			workspaceId: grant.workspaceId,
			grantId: grant.id,
		}
	})

	if (outcome.kind === 'refused') return outcome.result
	if (outcome.kind === 'reuse') {
		evictOAuthTokens()
		logger.warn('OAuth refresh token presented twice, grant revoked', { grantId: outcome.grantId })
		captureRefreshReuseRevoked({
			actorId: outcome.actorId,
			grantId: outcome.grantId,
			clientId: p.client_id,
			grantAgeSeconds: outcome.grantAgeSeconds,
			secondsSinceFirstUse: outcome.secondsSinceFirstUse,
		})
		// Counted by its own event above, so it is not also a token_rejected.
		return failure('invalid_grant')
	}
	captureTokenRefreshed({
		actorId: outcome.actorId,
		clientId: p.client_id,
		workspaceId: outcome.workspaceId,
		grantId: outcome.grantId,
	})
	return { ok: true, body: outcome.body }
}
