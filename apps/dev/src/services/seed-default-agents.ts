import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { DEFAULT_AGENTS } from '@maskin/shared'
import { and, eq, inArray } from 'drizzle-orm'

// Accept either the top-level db or an in-flight Drizzle transaction. The
// transaction callback parameter is the first argument's type of
// db.transaction; this alias keeps both call sites type-checking.
type Tx = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * Seat Driver, Coach, and Strategist on a workspace. Idempotent: any of the
 * three already a member of the workspace (matched by name) is skipped. New
 * agents are inserted with isSystem=true and a freshly generated apiKey.
 *
 * Call from inside the same transaction that creates the workspace so a
 * failure to seat the trio rolls the workspace creation back, matching how
 * Sindre is seeded today.
 */
export async function seedDefaultAgents(
	tx: Tx,
	workspaceId: string,
	createdBy: string,
): Promise<void> {
	const names = DEFAULT_AGENTS.map((a) => a.name)

	const existingRows = await tx
		.select({ name: actors.name })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(actors.name, names)))
	const alreadySeated = new Set(existingRows.map((r) => r.name))

	for (const tpl of DEFAULT_AGENTS) {
		if (alreadySeated.has(tpl.name)) continue

		const [actor] = await tx
			.insert(actors)
			.values({
				type: tpl.type,
				name: tpl.name,
				isSystem: tpl.isSystem,
				systemPrompt: tpl.systemPrompt,
				llmProvider: tpl.llmProvider,
				llmConfig: tpl.llmConfig,
				tools: tpl.tools,
				apiKey: generateApiKey().key,
				createdBy,
			})
			.returning()

		if (!actor) throw new Error(`Failed to seed ${tpl.name} actor`)

		await tx.insert(workspaceMembers).values({
			workspaceId,
			actorId: actor.id,
			role: 'member',
		})
	}
}
