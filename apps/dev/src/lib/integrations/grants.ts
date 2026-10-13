import type { Database, Transaction } from '@maskin/db'
import { type ScopeGrant, integrations } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'

type ActorGrant = Extract<ScopeGrant, { kind: 'actor' }>

/**
 * Appends one actor grant to integrations.scope_grants in a single statement, so
 * two concurrent appends cannot lose each other's entry. The write path for
 * grants that carry expiresAt and grantId; the access-request approval uses it.
 * Returns false when no row matched.
 */
export async function appendActorGrant(
	db: Database | Transaction,
	workspaceId: string,
	integrationId: string,
	grant: { actorId: string; expiresAt?: Date; grantId?: string },
): Promise<boolean> {
	const entry: ActorGrant = {
		kind: 'actor',
		actorId: grant.actorId,
		...(grant.expiresAt ? { expiresAt: grant.expiresAt.toISOString() } : {}),
		...(grant.grantId ? { grantId: grant.grantId } : {}),
	}
	const updated = await db
		.update(integrations)
		.set({ scopeGrants: sql`${integrations.scopeGrants} || ${JSON.stringify([entry])}::jsonb` })
		.where(and(eq(integrations.id, integrationId), eq(integrations.workspaceId, workspaceId)))
		.returning({ id: integrations.id })
	return updated.length > 0
}

/**
 * Expiry is judged at read time and nowhere else, so correctness needs no cron.
 * Only an actor grant can carry expiresAt. A grant is expired from the instant
 * expiresAt is reached. An expiresAt that does not parse counts as expired, so a
 * damaged entry fails closed.
 *
 * Known limit, accepted by the CTO for Tier 1: expiry is checked at launch (the
 * session's env build) and in getCredential, never while a session runs. A token
 * already injected into a running session as env stays usable until that session
 * ends. Expiry stops the next launch; it does not pull a credential out of a live
 * container. A hard stop at expiry is Tier 3 only and is not built here.
 */
export function isGrantExpired(grant: ScopeGrant, now: Date): boolean {
	if (grant.kind !== 'actor' || grant.expiresAt === undefined) return false
	return !(Date.parse(grant.expiresAt) > now.getTime())
}

/** The actor grants that name this actor and have not expired, in stored order. */
export function liveActorGrants(grants: unknown, actorId: string, now: Date): ActorGrant[] {
	if (!Array.isArray(grants)) return []
	return (grants as ScopeGrant[]).filter(
		(g): g is ActorGrant =>
			g?.kind === 'actor' &&
			typeof g.actorId === 'string' &&
			g.actorId === actorId &&
			!isGrantExpired(g, now),
	)
}

/** True when the credential is open to the whole workspace. A workspace grant never expires. */
export function hasWorkspaceGrant(grants: unknown): boolean {
	return Array.isArray(grants) && (grants as ScopeGrant[]).some((g) => g?.kind === 'workspace')
}
