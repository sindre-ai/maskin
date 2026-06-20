import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors, triggers, workspaceMembers } from '@maskin/db/schema'
import {
	DEFAULT_AGENTS,
	STRATEGIST_DEFAULT,
	STRATEGIST_RESEARCH_ON_SIGNUP_TRIGGER,
	STRATEGIST_RESEARCH_ON_SIGNUP_TRIGGER_NAME,
} from '@maskin/shared'
import { and, eq, inArray } from 'drizzle-orm'

// Accept either the top-level db or an in-flight Drizzle transaction. The
// transaction callback parameter is the first argument's type of
// db.transaction; this alias keeps both call sites type-checking.
type Tx = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * Seat Driver, Coach, and Strategist on a workspace, plus the standing
 * Strategist research-on-signup event trigger. Idempotent: any of the three
 * already a member of the workspace (matched by name) is skipped; the trigger
 * is skipped if a row with the same name already exists on the workspace.
 *
 * Call from inside the same transaction that creates the workspace so a
 * failure to seat the trio (or the trigger) rolls the workspace creation
 * back, matching how Sindre is seeded today.
 */
export async function seedDefaultAgents(
	tx: Tx,
	workspaceId: string,
	createdBy: string,
): Promise<void> {
	const names = DEFAULT_AGENTS.map((a) => a.name)

	const existingRows = await tx
		.select({ id: actors.id, name: actors.name })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(actors.name, names)))
	const existingByName = new Map(existingRows.map((r) => [r.name, r.id]))

	let strategistActorId = existingByName.get(STRATEGIST_DEFAULT.name) ?? null

	for (const tpl of DEFAULT_AGENTS) {
		if (existingByName.has(tpl.name)) continue

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

		if (tpl.name === STRATEGIST_DEFAULT.name) strategistActorId = actor.id

		await tx.insert(workspaceMembers).values({
			workspaceId,
			actorId: actor.id,
			role: 'member',
		})
	}

	if (!strategistActorId) {
		// Strategist was missing AND its insert silently produced no id — the
		// loop above would have thrown, so this is unreachable. Guard anyway so
		// the trigger insert never targets a null actor.
		throw new Error('Strategist actor id missing after seeding')
	}

	// Idempotent on (workspaceId, name): one trigger per workspace.
	const [existingTrigger] = await tx
		.select({ id: triggers.id })
		.from(triggers)
		.where(
			and(
				eq(triggers.workspaceId, workspaceId),
				eq(triggers.name, STRATEGIST_RESEARCH_ON_SIGNUP_TRIGGER_NAME),
			),
		)
		.limit(1)

	if (existingTrigger) return

	await tx.insert(triggers).values({
		workspaceId,
		name: STRATEGIST_RESEARCH_ON_SIGNUP_TRIGGER.name,
		type: STRATEGIST_RESEARCH_ON_SIGNUP_TRIGGER.type,
		config: STRATEGIST_RESEARCH_ON_SIGNUP_TRIGGER.config,
		actionPrompt: STRATEGIST_RESEARCH_ON_SIGNUP_TRIGGER.actionPrompt,
		targetActorId: strategistActorId,
		enabled: STRATEGIST_RESEARCH_ON_SIGNUP_TRIGGER.enabled,
		createdBy,
	})
}
