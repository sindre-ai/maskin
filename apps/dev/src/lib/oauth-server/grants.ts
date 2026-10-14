import type { Database, Transaction } from '@maskin/db'
import { oauthGrants, oauthTokens, workspaceMembers, workspaces } from '@maskin/db/schema'
import {
	MCP_OAUTH_PINNED_CLIENTS,
	type OauthGrantRow,
	type OauthRevokeReason,
} from '@maskin/shared'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { recordEvent } from '../events/record-event'

type Writer = Database | Transaction

export interface RefreshTokenState {
	revokedAt: Date | null
	usedAt: Date | null
	expiresAt: Date
}

/**
 * Whether a connection can still be refreshed. The ONE rule behind both the token endpoint's
 * refresh step and the grants list, so the page never shows Connected for a grant the token step
 * would refuse. A connection that goes 30 days without a refresh has an expired refresh token
 * and fails here, which is how "unused for 30 days" ends it.
 */
export function isGrantRefreshable(
	input: {
		grantRevokedAt: Date | null
		refreshToken: RefreshTokenState | null | undefined
		isMember: boolean
	},
	now: Date = new Date(),
): boolean {
	const { grantRevokedAt, refreshToken, isMember } = input
	return (
		grantRevokedAt === null &&
		isMember &&
		refreshToken !== null &&
		refreshToken !== undefined &&
		refreshToken.revokedAt === null &&
		refreshToken.usedAt === null &&
		refreshToken.expiresAt.getTime() > now.getTime()
	)
}

/**
 * Ends a grant and every token on it, and writes the audit row. Callers run evictOAuthTokens()
 * after the surrounding transaction commits. Returns false when the grant was already revoked.
 */
export async function revokeGrant(
	tx: Writer,
	params: { grantId: string; reason: OauthRevokeReason; byActorId: string | null },
): Promise<boolean> {
	const now = new Date()
	const [revoked] = await tx
		.update(oauthGrants)
		.set({ revokedAt: now, revokeReason: params.reason, revokedByActorId: params.byActorId })
		.where(and(eq(oauthGrants.id, params.grantId), isNull(oauthGrants.revokedAt)))
		.returning({
			id: oauthGrants.id,
			actorId: oauthGrants.actorId,
			workspaceId: oauthGrants.workspaceId,
		})
	await tx
		.update(oauthTokens)
		.set({ revokedAt: now })
		.where(and(eq(oauthTokens.grantId, params.grantId), isNull(oauthTokens.revokedAt)))
	if (!revoked) return false

	await recordEvent(tx, {
		workspaceId: revoked.workspaceId,
		actorId: params.byActorId ?? revoked.actorId,
		action: 'oauth_grant_revoked',
		entityType: 'oauth_grant',
		entityId: revoked.id,
		data: { grant_id: revoked.id, reason: params.reason, by_actor_id: params.byActorId },
	})
	return true
}

/** Removing a person from a workspace ends their live Claude connections to it. */
export async function revokeMemberGrants(
	tx: Writer,
	actorId: string,
	workspaceId: string,
): Promise<number> {
	const live = await tx
		.select({ id: oauthGrants.id })
		.from(oauthGrants)
		.where(
			and(
				eq(oauthGrants.actorId, actorId),
				eq(oauthGrants.workspaceId, workspaceId),
				isNull(oauthGrants.revokedAt),
			),
		)
	let revoked = 0
	for (const grant of live) {
		if (await revokeGrant(tx, { grantId: grant.id, reason: 'member_removed', byActorId: null })) {
			revoked += 1
		}
	}
	return revoked
}

/**
 * The person's connections for the pinned Claude client across all their workspaces, newest
 * first. A row exists only when isGrantRefreshable agrees (the same function the token endpoint
 * calls) and the person still has a membership row, which the join proves. workspace_name is a
 * join on the workspace, never the id.
 */
export async function listGrantsForActor(
	db: Database,
	actorId: string,
	now: Date = new Date(),
): Promise<OauthGrantRow[]> {
	const rows = await db
		.select({
			id: oauthGrants.id,
			clientId: oauthGrants.clientId,
			clientName: oauthGrants.clientName,
			workspaceId: oauthGrants.workspaceId,
			workspaceName: workspaces.name,
			createdAt: oauthGrants.createdAt,
			lastUsedAt: oauthGrants.lastUsedAt,
		})
		.from(oauthGrants)
		.innerJoin(workspaces, eq(workspaces.id, oauthGrants.workspaceId))
		.innerJoin(
			workspaceMembers,
			and(
				eq(workspaceMembers.workspaceId, oauthGrants.workspaceId),
				eq(workspaceMembers.actorId, oauthGrants.actorId),
			),
		)
		.where(
			and(
				eq(oauthGrants.actorId, actorId),
				isNull(oauthGrants.revokedAt),
				inArray(oauthGrants.clientId, Object.keys(MCP_OAUTH_PINNED_CLIENTS)),
			),
		)
		.orderBy(desc(oauthGrants.createdAt))
	if (rows.length === 0) return []

	const tokens = await db
		.select({
			grantId: oauthTokens.grantId,
			revokedAt: oauthTokens.revokedAt,
			usedAt: oauthTokens.usedAt,
			expiresAt: oauthTokens.expiresAt,
		})
		.from(oauthTokens)
		.where(
			and(
				eq(oauthTokens.kind, 'refresh'),
				inArray(
					oauthTokens.grantId,
					rows.map((row) => row.id),
				),
			),
		)
		.orderBy(desc(oauthTokens.createdAt))
	// Newest refresh token per grant: rotation leaves older ones marked used.
	const latest = new Map<string, RefreshTokenState>()
	for (const token of tokens) if (!latest.has(token.grantId)) latest.set(token.grantId, token)

	return rows
		.filter((row) =>
			isGrantRefreshable(
				{ grantRevokedAt: null, refreshToken: latest.get(row.id), isMember: true },
				now,
			),
		)
		.map((row) => ({
			id: row.id,
			client_id: row.clientId,
			client_name: row.clientName,
			workspace_id: row.workspaceId,
			workspace_name: row.workspaceName,
			created_at: row.createdAt.toISOString(),
			last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
		}))
}
