import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors, workspaceMembers, workspaces } from '@maskin/db/schema'
import { CHIEF_OF_STAFF_DEFAULT } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'

// A caller can pass either the top-level Database or a Drizzle tx handle —
// both expose the query-builder surface this file uses.
type Tx = Pick<Database, 'select' | 'insert' | 'update'>

/**
 * Idempotently ensures a Chief of Staff actor exists in the workspace,
 * creating it if missing. Returns its actor id either way.
 *
 * Used only by the manual `scripts/seed-default-agent.ts` backfill — new
 * workspaces no longer auto-seed any default agents (see workspaces.ts,
 * actors.ts, dev-bootstrap.ts).
 */
export async function ensureChiefOfStaffActor(
	db: Tx,
	workspaceId: string,
	createdBy: string,
): Promise<string> {
	const [existing] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.name, CHIEF_OF_STAFF_DEFAULT.name),
			),
		)
		.limit(1)

	if (existing) return existing.actorId

	const [created] = await db
		.insert(actors)
		.values({
			type: CHIEF_OF_STAFF_DEFAULT.type,
			name: CHIEF_OF_STAFF_DEFAULT.name,
			isSystem: CHIEF_OF_STAFF_DEFAULT.isSystem,
			systemPrompt: CHIEF_OF_STAFF_DEFAULT.systemPrompt.replaceAll('{{self_id}}', ''),
			llmProvider: CHIEF_OF_STAFF_DEFAULT.llmProvider,
			llmConfig: CHIEF_OF_STAFF_DEFAULT.llmConfig as Record<string, unknown>,
			tools: CHIEF_OF_STAFF_DEFAULT.tools as Record<string, unknown>,
			apiKey: generateApiKey().key,
			createdBy,
		})
		.returning()

	if (!created) throw new Error('Failed to create Chief of Staff actor')

	await db.insert(workspaceMembers).values({
		workspaceId,
		actorId: created.id,
		role: 'member',
	})

	return created.id
}

/**
 * Pins `agentActorId` as the workspace's default chat agent, but only if
 * `settings.default_agent_id` isn't already set — never clobbers an
 * explicit choice (owner pick, or a prior run of this same function).
 * Returns whether it made a change.
 */
export async function pinDefaultAgentIfUnset(
	db: Tx,
	workspaceId: string,
	agentActorId: string,
): Promise<boolean> {
	const [ws] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	const currentSettings = (ws?.settings ?? {}) as Record<string, unknown>
	if (currentSettings.default_agent_id != null) return false

	await db
		.update(workspaces)
		.set({ settings: { ...currentSettings, default_agent_id: agentActorId } })
		.where(eq(workspaces.id, workspaceId))

	return true
}
