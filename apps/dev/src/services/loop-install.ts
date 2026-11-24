import { randomUUID } from 'node:crypto'
import type { Transaction } from '@maskin/db'
import {
	actors,
	agentSkills,
	installedLoops,
	integrations,
	type marketplaceLoopItems,
	type marketplaceLoops,
	objects,
	triggers,
	workspaceMembers,
	workspaceSkills,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { loopSettingsForInstall, readLoopSettings } from '../lib/marketplace-loops/loop-settings'
import { type AgentStorageManager, workspaceSkillKey } from './agent-storage'
import {
	type MarketplaceItemType,
	buildActorInsert,
	buildIntegrationInsert,
	buildSkillInsert,
	buildTriggerInsert,
	findProvisionedActorBySourceItem,
	findProvisionedSkillBySourceItem,
	findWorkspaceSkillByName,
	installMetadata,
	rewriteWiring,
} from './loop-provisioning'
import { syncLoopViews, toViewItems } from './loop-views-provisioning'

/**
 * A skill provisioned from a marketplace item collided with an unrelated,
 * differently-sourced skill that already has the same name in this workspace
 * — the dedup-by-source-item guard only catches the case where it's genuinely
 * the same shared item. `workspace_skills` enforces `(workspace_id, name)`
 * uniqueness at the DB level, so this surfaces as a 23505 on insert; callers
 * convert it into a clean 409 (route) or a logged skip (workspace bootstrap)
 * instead of an unhandled 500.
 */
export class SkillNameConflictError extends Error {
	constructor(readonly skillName: string) {
		super(`A skill named "${skillName}" already exists in this workspace`)
	}
}

export type ProvisionedCounts = {
	actors: number
	triggers: number
	skills: number
	integrations: number
}

/**
 * Installs one marketplace loop into a workspace, inside the caller's
 * transaction: the `installed_loops` row, every actor, skill, integration and
 * trigger of the bundle, the Loop object and its custom views. The caller has
 * already resolved the loop and its items and checked the workspace does not
 * have it installed yet.
 *
 * Shared by `POST /api/installed-loops` and workspace provisioning, so a flow a
 * new workspace starts with is installed exactly the way a person installing it
 * from the marketplace gets it. Post-commit work (subscribing the installer,
 * analytics, the personalization chat) stays with the caller.
 */
export async function installLoopInTransaction(
	tx: Transaction,
	params: {
		workspaceId: string
		actorId: string
		loop: typeof marketplaceLoops.$inferSelect
		items: (typeof marketplaceLoopItems.$inferSelect)[]
		agentStorage: AgentStorageManager
		storageProvider: StorageProvider
	},
): Promise<{ installed: typeof installedLoops.$inferSelect; provisioned: ProvisionedCounts }> {
	const { workspaceId, actorId, loop, items, agentStorage, storageProvider } = params
	const loopId = loop.id
	const provisioned: ProvisionedCounts = { actors: 0, triggers: 0, skills: 0, integrations: 0 }

	const [installRow] = await tx
		.insert(installedLoops)
		.values({
			workspaceId,
			sourceLoopId: loopId,
			installedVersion: loop.version,
			isLocked: true,
		})
		.returning()

	if (!installRow) throw new Error('Failed to insert installed_loops row')

	// 4. Two-pass provisioning so triggers can reference any actor in the same
	//    loop even when the actor is inserted later in the marketplace ordering.
	//
	//    Pass 1: insert every item, capturing source_item_id → new_local_id.
	//    Triggers go last so their `target_actor_id` (which the snapshot
	//    expresses as a source id) can be rewritten against the now-complete
	//    map. We can't insert a trigger without a real target_actor_id (FK
	//    NOT NULL), so the pre-pass + ordering is load-bearing.
	const sourceToLocal = new Map<string, string>()

	const triggerItems: Array<{ sourceItemId: string; snapshot: Record<string, unknown> }> = []
	// Skill → source-actor-id bindings, resolved to agent_skills rows once
	// pass 1 finishes and every actor/skill in the loop has a local id.
	const skillActorBindings: Array<{ sourceSkillId: string; sourceActorIds: string[] }> = []

	for (const item of items) {
		const type = item.itemType as MarketplaceItemType
		const snapshot = (item.itemSnapshot as Record<string, unknown>) ?? {}
		const metadata = installMetadata(installRow.id, item.sourceItemId, snapshot)

		switch (type) {
			case 'actor': {
				// Dedup guard: don't clone an agent the workspace already has. A
				// workspace may already hold this agent from another loop that bundles
				// it, or from a previous install kept on uninstall — reuse the existing
				// row and wire this install's triggers to it instead of creating a
				// second copy. Reuse means `provisioned.actors` only counts agents this
				// install actually created.
				const existing = await findProvisionedActorBySourceItem(tx, workspaceId, item.sourceItemId)
				if (existing) {
					sourceToLocal.set(item.sourceItemId, existing.id)
					break
				}
				const [row] = await tx
					.insert(actors)
					.values(buildActorInsert(snapshot, metadata, actorId))
					.returning({ id: actors.id })
				if (!row) throw new Error(`insert returned no row for actor ${item.sourceItemId}`)
				// Actors are global identities; a workspace_members row is what binds one
				// to a workspace. Without it the provisioned agent is orphaned — it never
				// shows up in the workspace's agent list (those queries join through
				// workspace_members) and its own MCP/API calls, which carry X-Workspace-Id,
				// would 403 in authMiddleware, so a trigger targeting it couldn't run.
				// Mirrors how the seeded Workspace Coach agent is added on workspace creation.
				await tx.insert(workspaceMembers).values({
					workspaceId,
					actorId: row.id,
					role: 'member',
				})
				sourceToLocal.set(item.sourceItemId, row.id)
				provisioned.actors++
				break
			}
			case 'skill': {
				const attachedActorIds = Array.isArray(snapshot.attachedActorIds)
					? (snapshot.attachedActorIds as string[])
					: []
				const skillName = (snapshot.name as string) ?? 'untitled-skill'
				const reuseSkill = (id: string) => {
					sourceToLocal.set(item.sourceItemId, id)
					if (attachedActorIds.length > 0) {
						skillActorBindings.push({
							sourceSkillId: item.sourceItemId,
							sourceActorIds: attachedActorIds,
						})
					}
				}

				// Dedup guard, mirroring the actor case above: don't clone a skill
				// the workspace already has. Two loops can legitimately bundle the
				// same shared skill, and `workspace_skills` has a
				// `(workspace_id, name)` unique index — a bare insert on the second
				// install would collide on it (23505) instead of reusing the row.
				const existingSkill = await findProvisionedSkillBySourceItem(
					tx,
					workspaceId,
					item.sourceItemId,
				)
				if (existingSkill) {
					reuseSkill(existingSkill.id)
					break
				}

				// Fallback dedup guard: two loops published independently (different
				// `source_item_id`s) can still bundle a skill with the same name —
				// not "the same" shared item by identity, but the unique index treats
				// them as one anyway. Reuse the existing row by name rather than
				// refusing the whole install.
				const existingByName = await findWorkspaceSkillByName(tx, workspaceId, skillName)
				if (existingByName) {
					reuseSkill(existingByName.id)
					break
				}

				// Fresh id + workspace-scoped S3 key — never reuse the publisher's
				// storageKey (see buildSkillInsert). The S3 put happens inside the
				// tx, right after the insert, mirroring workspace-skills.ts's POST.
				const skillId = randomUUID()
				const storageKey = workspaceSkillKey(workspaceId, skillId)
				let row: { id: string } | undefined
				try {
					;[row] = await tx
						.insert(workspaceSkills)
						.values(buildSkillInsert(workspaceId, skillId, storageKey, snapshot, metadata, actorId))
						.returning({ id: workspaceSkills.id })
				} catch (err) {
					const cause = (err as { cause?: { code?: string; table_name?: string } }).cause
					if (cause?.code === '23505' && cause.table_name === 'workspace_skills') {
						// Lost a race against a concurrent install that just created the
						// same-named row between our check above and this insert — reuse
						// it instead of failing the whole install.
						const reconciled = await findWorkspaceSkillByName(tx, workspaceId, skillName)
						if (reconciled) {
							reuseSkill(reconciled.id)
							break
						}
						throw new SkillNameConflictError(skillName)
					}
					throw err
				}
				if (!row) throw new Error(`insert returned no row for skill ${item.sourceItemId}`)
				await agentStorage.putWorkspaceSkill(
					workspaceId,
					skillId,
					(snapshot.content as string) ?? '',
				)
				sourceToLocal.set(item.sourceItemId, row.id)
				provisioned.skills++
				if (attachedActorIds.length > 0) {
					skillActorBindings.push({
						sourceSkillId: item.sourceItemId,
						sourceActorIds: attachedActorIds,
					})
				}
				break
			}
			case 'integration': {
				const [row] = await tx
					.insert(integrations)
					.values(buildIntegrationInsert(workspaceId, snapshot, metadata, actorId))
					.returning({ id: integrations.id })
				if (!row) throw new Error(`insert returned no row for integration ${item.sourceItemId}`)
				sourceToLocal.set(item.sourceItemId, row.id)
				provisioned.integrations++
				break
			}
			case 'trigger':
				triggerItems.push({ sourceItemId: item.sourceItemId, snapshot })
				break
		}
	}

	// Bind each provisioned skill to the actor(s) it was attached to in the
	// source workspace, now that pass 1 has resolved both sides to local ids.
	// Source actor ids that weren't part of this loop (or weren't resolved
	// for any reason) are silently skipped rather than treated as an error —
	// a skill can legitimately be attached to actors outside the loop.
	for (const { sourceSkillId, sourceActorIds } of skillActorBindings) {
		const localSkillId = sourceToLocal.get(sourceSkillId)
		if (!localSkillId) continue
		for (const sourceActorId of sourceActorIds) {
			const localActorId = sourceToLocal.get(sourceActorId)
			if (!localActorId) continue
			await tx
				.insert(agentSkills)
				.values({ actorId: localActorId, workspaceSkillId: localSkillId })
				.onConflictDoNothing()
		}
	}

	const provisionedTriggerIds: string[] = []
	for (const { sourceItemId, snapshot } of triggerItems) {
		const rewritten = rewriteWiring(snapshot, sourceToLocal)
		const metadata = installMetadata(installRow.id, sourceItemId, rewritten)
		const [row] = await tx
			.insert(triggers)
			.values(buildTriggerInsert(workspaceId, rewritten, metadata, actorId))
			.returning({ id: triggers.id })
		if (!row) throw new Error(`insert returned no row for trigger ${sourceItemId}`)
		sourceToLocal.set(sourceItemId, row.id)
		provisionedTriggerIds.push(row.id)
		provisioned.triggers++
	}

	// Create the Loop object this install represents (see route comment) and
	// link it back on the install row.
	const [loopObject] = await tx
		.insert(objects)
		.values({
			workspaceId,
			type: 'loop',
			title: loop.name,
			content: loop.description,
			// Marketplace templates are pre-vetted, but the loop is still new to
			// this workspace's data — start it at `pilot` rather than
			// `live` so its first runs get a look before it's fully
			// trusted here.
			status: 'pilot',
			createdBy: actorId,
			metadata: {
				installed_from_marketplace_loop_id: loopId,
				trigger_ids: provisionedTriggerIds,
				...loopSettingsForInstall(readLoopSettings(loop.loopSettings)),
			},
		})
		.returning()
	if (!loopObject) throw new Error('Failed to insert loop object for install')

	await tx
		.update(installedLoops)
		.set({ objectId: loopObject.id })
		.where(eq(installedLoops.id, installRow.id))

	// The loop's custom views: each becomes a new page in this workspace and
	// a tab on the loop object. Needs the loop object's id, so it runs here.
	const viewItems = toViewItems(items)
	if (viewItems.length > 0) {
		await syncLoopViews({
			db: tx,
			storage: storageProvider,
			workspaceId,
			loopObjectId: loopObject.id,
			actorId,
			items: viewItems,
		})
	}

	await recordEvent(tx, {
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'loop',
		entityId: loopObject.id,
		data: loopObject,
	})

	await recordEvent(tx, {
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'installed_loop',
		entityId: installRow.id,
		data: {
			source_loop_id: loopId,
			installed_version: loop.version,
			object_id: loopObject.id,
			items: provisioned,
		},
	})

	return { installed: { ...installRow, objectId: loopObject.id }, provisioned }
}
