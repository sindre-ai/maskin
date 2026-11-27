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
import { and, eq, inArray, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import {
	type LoopSettings,
	loopSettingsForInstall,
	loopSettingsPatch,
	readLoopSettings,
} from '../lib/marketplace-loops/loop-settings'
import { type AgentStorageManager, workspaceSkillKey } from './agent-storage'
import { provisionLoopChecklist } from './loop-checklist-provisioning'
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
	isRoleActorId,
	resolveRoleActors,
	rewriteWiring,
	roleIdsOfItems,
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

/** What the caller needs to start the checklist's driver once the install has committed. */
export type ChecklistStart = { parentTaskId: string; driverActorId: string | null }

/** What the caller needs to introduce the agent once an agent-only install has committed. */
export type AgentOnlyInstall = { actorId: string; firstLook: string | null }

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
): Promise<{
	installed: typeof installedLoops.$inferSelect
	provisioned: ProvisionedCounts
	/** Set only when the flow ships a checklist and its tasks were created by this call. */
	checklistStart: ChecklistStart | null
	/** Set only for an agent-only listing: the agent to say hello for, and where it should look first. */
	agentOnly: AgentOnlyInstall | null
}> {
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
	// The first agent the bundle ships (created here or reused), for an agent-only listing.
	let firstAgentId: string | null = null
	// Agents the bundle names by role instead of shipping (see resolveRoleActors): bound to the
	// workspace's own agent of that role, so triggers and skills wire up like any bundled agent.
	for (const [roleId, localId] of await resolveRoleActors(tx, workspaceId, roleIdsOfItems(items))) {
		sourceToLocal.set(roleId, localId)
	}

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
					firstAgentId ??= existing.id
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
				firstAgentId ??= row.id
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
		// The workspace has no agent for the role this trigger names: skip it, the rest installs.
		if (isRoleActorId(rewritten.targetActorId ?? rewritten.target_actor_id)) {
			logger.warn('Skipped marketplace trigger: the workspace has no agent for its role', {
				workspaceId,
				installId: installRow.id,
				triggerSourceItemId: sourceItemId,
			})
			continue
		}
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

	const shippedSettings = readLoopSettings(loop.loopSettings)

	// A listing that is one agent: no flow object, no views, no checklist and no flow event. The
	// install row keeps a null object_id, which uninstall and the version push already handle.
	if (shippedSettings?.agentOnly) {
		if (!firstAgentId) throw new Error('Agent-only listing ships no agent')
		await recordEvent(tx, {
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'installed_loop',
			entityId: installRow.id,
			data: {
				source_loop_id: loopId,
				installed_version: loop.version,
				object_id: null,
				items: provisioned,
			},
		})
		return {
			installed: installRow,
			provisioned,
			checklistStart: null,
			agentOnly: { actorId: firstAgentId, firstLook: shippedSettings.firstLook ?? null },
		}
	}

	// Create the Loop object this install represents (see route comment) and
	// link it back on the install row. A flow that ships `adoptExisting` links the workspace's own
	// hand-made flow of the same name instead of creating a second one.
	const adopted = shippedSettings?.adoptExisting
		? await adoptExistingLoopObject(tx, {
				workspaceId,
				title: loop.name,
				loopId,
				provisionedTriggerIds,
				boundActorIds: new Set(
					[...sourceToLocal].filter(([source]) => isRoleActorId(source)).map(([, local]) => local),
				),
				settings: shippedSettings,
			})
		: null
	let loopObject = adopted
	if (!loopObject) {
		const [created] = await tx
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
		loopObject = created ?? null
	}
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

	// The loop's onboarding checklist, if it ships one: a parent task and a child task per
	// prerequisite, driven by the bundled agent it names.
	let checklistStart: ChecklistStart | null = null
	// An adopted flow is already running, so it does not get a first-day checklist.
	const checklist = adopted ? undefined : readLoopSettings(loop.loopSettings)?.checklist
	if (checklist) {
		const driverActorId = checklist.driverSourceItemId
			? (sourceToLocal.get(checklist.driverSourceItemId) ?? null)
			: null
		const { parentTaskId } = await provisionLoopChecklist({
			db: tx,
			workspaceId,
			actorId,
			installId: installRow.id,
			loopObjectId: loopObject.id,
			checklist,
			driverActorId,
		})
		if (parentTaskId) checklistStart = { parentTaskId, driverActorId }
	}

	await recordEvent(tx, {
		workspaceId,
		actorId,
		action: adopted ? 'updated' : 'created',
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

	return {
		installed: { ...installRow, objectId: loopObject.id },
		provisioned,
		checklistStart,
		agentOnly: null,
	}
}

/**
 * Links a hand-made flow the workspace already has, with the same title, to this install instead of
 * creating a second one. Only taken when exactly one flow with that title is not yet marketplace-linked;
 * with none or several nothing is adopted and the install creates its own flow. Its content, status,
 * comments and tabs stay as they are; a tab with the same name as a shipped one is kept (the view
 * sync skips a taken name). Of the triggers it ran before, only those the bundle replaces (named in
 * `replacesTriggerNames`, running on an agent this install bound) are switched off, not deleted, and
 * their ids are kept on the flow as `replaced_trigger_ids` so they can be switched back on. Any other
 * trigger on the flow is left running and named in the log. Returns null when there is nothing to adopt.
 */
async function adoptExistingLoopObject(
	tx: Transaction,
	params: {
		workspaceId: string
		title: string
		loopId: string
		provisionedTriggerIds: string[]
		boundActorIds: Set<string>
		settings: LoopSettings
	},
): Promise<typeof objects.$inferSelect | null> {
	const { workspaceId, title, loopId, provisionedTriggerIds, boundActorIds, settings } = params
	const candidates = await tx
		.select()
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'loop'),
				eq(objects.title, title),
				sql`coalesce(${objects.metadata}->>'installed_from_marketplace_loop_id', '') = ''`,
			),
		)
		.limit(2)
	const [existing] = candidates
	if (candidates.length !== 1 || !existing) {
		if (candidates.length > 1) {
			logger.warn('Marketplace flow not adopted: several unlinked flows share its title', {
				workspaceId,
				title,
			})
		}
		return null
	}

	const meta = (existing.metadata as Record<string, unknown> | null) ?? {}
	const oldTriggerIds = Array.isArray(meta.trigger_ids)
		? (meta.trigger_ids as unknown[]).filter((id): id is string => typeof id === 'string')
		: []
	const replaces = new Set(settings.replacesTriggerNames ?? [])
	const replacedIds: string[] = []
	const keptNames: string[] = []
	if (oldTriggerIds.length > 0) {
		const oldTriggers = await tx
			.select({ id: triggers.id, name: triggers.name, targetActorId: triggers.targetActorId })
			.from(triggers)
			.where(and(eq(triggers.workspaceId, workspaceId), inArray(triggers.id, oldTriggerIds)))
		for (const t of oldTriggers) {
			if (replaces.has(t.name) && boundActorIds.has(t.targetActorId)) replacedIds.push(t.id)
			else keptNames.push(t.name)
		}
	}
	if (replacedIds.length > 0) {
		await tx
			.update(triggers)
			.set({ enabled: false, updatedAt: new Date() })
			.where(and(eq(triggers.workspaceId, workspaceId), inArray(triggers.id, replacedIds)))
	}
	logger.info('Marketplace flow adopted', {
		workspaceId,
		title,
		flowId: existing.id,
		switchedOffTriggers: replacedIds.length,
		leftRunningTriggers: keptNames,
	})

	// The install's triggers replace the old ones in the flow's list. A trigger left running stays in it.
	const keptIds = oldTriggerIds.filter((id) => !replacedIds.includes(id))
	const [updated] = await tx
		.update(objects)
		.set({
			metadata: {
				...meta,
				...loopSettingsPatch(settings, meta),
				installed_from_marketplace_loop_id: loopId,
				trigger_ids: [...provisionedTriggerIds, ...keptIds],
				...(replacedIds.length > 0 ? { replaced_trigger_ids: replacedIds } : {}),
			},
			updatedAt: new Date(),
		})
		.where(eq(objects.id, existing.id))
		.returning()
	return updated ?? null
}
