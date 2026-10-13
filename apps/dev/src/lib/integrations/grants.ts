import type { Database, Transaction } from '@maskin/db'
import { type ScopeGrant, integrations } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'

type ActorGrant = Extract<ScopeGrant, { kind: 'actor' }>

/**
 * Appends one actor grant to integrations.scope_grants in a single statement, so
 * two concurrent appends cannot lose each other's entry. The write path for
 * grants that carry expiresAt and grantId; the access-request approval and the
 * expiry sweeper use it. Nothing here reads expiresAt: enforcing it at launch
 * and in getCredential is the expiry task. Returns false when no row matched.
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
