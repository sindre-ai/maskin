import type { Database, Transaction } from '@maskin/db'
import { type AgentGrantAccess, agentGrants } from '@maskin/db/schema'
import { and, eq, notInArray, sql } from 'drizzle-orm'

/**
 * Writers for agent_grants. Reads and the access decision live in agent-access.ts.
 * Every function takes a transaction so the caller can bundle the audit row and the
 * events row with the change.
 */

/** Keychain credentials have no read/write split: a grant is on, stored as read_write. */
export const KEYCHAIN_ACCESS: AgentGrantAccess = 'read_write'

/** Inserts on-grants for the given agents; existing rows are left as they are. */
export async function insertKeychainGrants(
	tx: Database | Transaction,
	input: { workspaceId: string; integrationId: string; actorIds: string[]; createdBy: string },
): Promise<void> {
	const ids = [...new Set(input.actorIds)]
	if (ids.length === 0) return
	await tx
		.insert(agentGrants)
		.values(
			ids.map((actorId) => ({
				workspaceId: input.workspaceId,
				integrationId: input.integrationId,
				actorId,
				access: KEYCHAIN_ACCESS,
				createdBy: input.createdBy,
			})),
		)
		.onConflictDoNothing({ target: [agentGrants.integrationId, agentGrants.actorId] })
}

/**
 * Makes the explicit grants on an integration equal `grants`: removes the rest, adds or
 * updates the listed. Returns the grants before and after, for the audit trail.
 */
export async function replaceAgentGrants(
	tx: Transaction,
	input: {
		workspaceId: string
		integrationId: string
		grants: { actorId: string; access: AgentGrantAccess }[]
		createdBy: string
	},
): Promise<{
	before: { actorId: string; access: AgentGrantAccess }[]
	after: { actorId: string; access: AgentGrantAccess }[]
}> {
	const before = await tx
		.select({ actorId: agentGrants.actorId, access: agentGrants.access })
		.from(agentGrants)
		.where(eq(agentGrants.integrationId, input.integrationId))
	// Last write wins for a repeated agent.
	const byActor = new Map(input.grants.map((g) => [g.actorId, g.access]))
	const after = [...byActor].map(([actorId, access]) => ({ actorId, access }))
	if (after.length === 0) {
		await tx.delete(agentGrants).where(eq(agentGrants.integrationId, input.integrationId))
		return { before, after }
	}
	await tx.delete(agentGrants).where(
		and(
			eq(agentGrants.integrationId, input.integrationId),
			notInArray(
				agentGrants.actorId,
				after.map((g) => g.actorId),
			),
		),
	)
	await tx
		.insert(agentGrants)
		.values(
			after.map((g) => ({
				workspaceId: input.workspaceId,
				integrationId: input.integrationId,
				actorId: g.actorId,
				access: g.access,
				createdBy: input.createdBy,
			})),
		)
		.onConflictDoUpdate({
			target: [agentGrants.integrationId, agentGrants.actorId],
			set: { access: sql`excluded.access`, updatedAt: new Date() },
		})
	return { before, after }
}

/** Sets one agent's grant. Returns the previous access (null if it had no row). */
export async function upsertAgentGrant(
	tx: Transaction,
	input: {
		workspaceId: string
		integrationId: string
		actorId: string
		access: AgentGrantAccess
		createdBy: string
	},
): Promise<AgentGrantAccess | null> {
	const [existing] = await tx
		.select({ access: agentGrants.access })
		.from(agentGrants)
		.where(
			and(
				eq(agentGrants.integrationId, input.integrationId),
				eq(agentGrants.actorId, input.actorId),
			),
		)
		.for('update')
		.limit(1)
	await tx
		.insert(agentGrants)
		.values({
			workspaceId: input.workspaceId,
			integrationId: input.integrationId,
			actorId: input.actorId,
			access: input.access,
			createdBy: input.createdBy,
		})
		.onConflictDoUpdate({
			target: [agentGrants.integrationId, agentGrants.actorId],
			set: { access: input.access, updatedAt: new Date() },
		})
	return existing?.access ?? null
}

/** Removes one agent's grant. Returns the access it had, or null if there was none. */
export async function removeAgentGrant(
	tx: Transaction,
	input: { integrationId: string; actorId: string },
): Promise<AgentGrantAccess | null> {
	const [removed] = await tx
		.delete(agentGrants)
		.where(
			and(
				eq(agentGrants.integrationId, input.integrationId),
				eq(agentGrants.actorId, input.actorId),
			),
		)
		.returning({ access: agentGrants.access })
	return removed?.access ?? null
}
