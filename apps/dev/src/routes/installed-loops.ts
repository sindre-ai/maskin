import { randomUUID } from 'node:crypto'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	agentFiles,
	agentSkills,
	files,
	imports,
	installedLoops,
	integrations,
	marketplaceLoopItems,
	marketplaceLoops,
	notifications,
	objects,
	readState,
	relationships,
	sessionLogs,
	sessions,
	subscriptions,
	triggers,
	workspaceMembers,
	workspaceSkills,
	workspaces,
} from '@maskin/db/schema'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import {
	trackLoopForked,
	trackLoopInstalled,
	trackLoopUninstalled,
} from '../lib/analytics/loop-events'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, jsonbField } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'
import { type AgentStorageManager, workspaceSkillKey } from '../services/agent-storage'
import {
	type MarketplaceItemType,
	applyExtensionSnapshot,
	buildActorInsert,
	buildIntegrationInsert,
	buildSkillInsert,
	buildTriggerInsert,
	findProvisionedActorBySourceItem,
	findProvisionedSkillBySourceItem,
	findWorkspaceSkillByName,
	installMetadata,
	partitionProvisionedActors,
	partitionProvisionedSkills,
	rewriteWiring,
	sourceItemIdOf,
} from '../services/loop-provisioning'
import { autoSubscribe } from '../services/subscriptions'

type Env = {
	Variables: {
		db: Database
		actorId: string
		agentStorage: AgentStorageManager
	}
}

const app = new OpenAPIHono<Env>()

/**
 * A skill provisioned from a marketplace item collided with an unrelated,
 * differently-sourced skill that already has the same name in this workspace
 * — the dedup-by-source-item guard only catches the case where it's genuinely
 * the same shared item. `workspace_skills` enforces `(workspace_id, name)`
 * uniqueness at the DB level, so this surfaces as a 23505 on insert; caught
 * and converted into a clean 409 instead of an unhandled 500.
 */
class SkillNameConflictError extends Error {
	constructor(readonly skillName: string) {
		super(`A skill named "${skillName}" already exists in this workspace`)
	}
}

const installLoopBodySchema = z.object({
	loopId: z.string().uuid(),
	workspaceId: z.string().uuid(),
})

const listInstalledLoopsQuerySchema = z.object({
	workspaceId: z.string().uuid(),
})

const installedLoopRowSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	sourceLoopId: z.string().uuid(),
	objectId: z.string().uuid().nullable(),
	installedVersion: z.string(),
	isLocked: z.boolean(),
	forkedAt: z.string().nullable(),
	installedAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	availableVersion: z.string(),
	hasUpdate: z.boolean(),
	loopName: z.string(),
})

const listInstalledLoopsResponseSchema = z.object({
	installs: z.array(installedLoopRowSchema),
})

const installedLoopResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	sourceLoopId: z.string().uuid(),
	objectId: z.string().uuid().nullable(),
	installedVersion: z.string(),
	isLocked: z.boolean(),
	forkedAt: z.string().nullable(),
	installedAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	provisioned: z.object({
		actors: z.number(),
		triggers: z.number(),
		skills: z.number(),
		integrations: z.number(),
		extensions: z.number(),
	}),
	metadata: jsonbField.optional(),
})

// GET /api/installed-loops?workspaceId=… — list the workspace's installs.
//
// Joins on marketplace_loops so each row carries the current published version
// alongside the installed version, plus a derived `hasUpdate` flag. The
// marketplace UI uses this to render the badge state (managed / forked) and
// the amber update banner on locked rows whose installed_version trails the
// marketplace loop version (the T5 cron normally closes this gap within an
// hour, but the gap is real between cron ticks and we want the user to see it).
const listInstalledLoopsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['installed-loops'],
	summary: 'List installed loops for a workspace',
	request: {
		query: listInstalledLoopsQuerySchema,
	},
	responses: {
		200: {
			description: 'Installed loops with current marketplace version',
			content: { 'application/json': { schema: listInstalledLoopsResponseSchema } },
		},
		400: {
			description: 'Validation error',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not a member of the target workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listInstalledLoopsRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { workspaceId } = c.req.valid('query')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'You are not a member of the target workspace'), 403)
	}

	const rows = await db
		.select({
			id: installedLoops.id,
			workspaceId: installedLoops.workspaceId,
			sourceLoopId: installedLoops.sourceLoopId,
			objectId: installedLoops.objectId,
			installedVersion: installedLoops.installedVersion,
			isLocked: installedLoops.isLocked,
			forkedAt: installedLoops.forkedAt,
			installedAt: installedLoops.installedAt,
			updatedAt: installedLoops.updatedAt,
			availableVersion: marketplaceLoops.version,
			loopName: marketplaceLoops.name,
		})
		.from(installedLoops)
		.innerJoin(marketplaceLoops, eq(marketplaceLoops.id, installedLoops.sourceLoopId))
		.where(eq(installedLoops.workspaceId, workspaceId))

	return c.json(
		{
			installs: rows.map((row) => ({
				...serialize(row),
				availableVersion: row.availableVersion,
				hasUpdate: row.installedVersion !== row.availableVersion,
				loopName: row.loopName,
			})),
		},
		200,
	)
})

// POST /api/installed-loops — provision a marketplace loop into a workspace.
//
// Locked install (is_locked = true): Maskin owns the install and the version-push
// cron (T5) keeps it in sync. The caller can fork later via T4 to detach.
//
// Also creates an `objects` row (`type = 'loop'`) representing this install as
// a running loops-first-class Loop — see the comment above `marketplaceLoops`
// in packages/db/src/schema.ts. `metadata.trigger_ids` is seeded with every
// trigger this install provisions so `GET /api/loops` picks up the right
// agents (it derives `agentIds` from each trigger's `targetActorId`).
// `entry_condition` / `close_condition` / `human_decision_points` are
// deliberately left unset — a marketplace install has no authored pipeline
// definition, only the running process.
const installLoopRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['installed-loops'],
	summary: 'Install a marketplace loop into a workspace',
	request: {
		body: {
			content: { 'application/json': { schema: installLoopBodySchema } },
		},
	},
	responses: {
		201: {
			description: 'Loop installed',
			content: { 'application/json': { schema: installedLoopResponseSchema } },
		},
		400: {
			description: 'Validation error',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not a member of the target workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Marketplace loop not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Loop already installed in this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(installLoopRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const agentStorage = c.get('agentStorage')
	const { loopId, workspaceId } = c.req.valid('json')

	// 1. Caller must belong to the target workspace. We check resource-scoped
	//    membership here rather than via the workspace-id header because the
	//    workspace is part of the install body, not the request envelope.
	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'You are not a member of the target workspace'), 403)
	}

	// 2. Resolve the loop + its frozen items. A loop with zero items is
	//    legal — it installs an empty `installed_loops` row that the cron
	//    will catch up on the next push if the publisher adds items.
	const [loop] = await db
		.select()
		.from(marketplaceLoops)
		.where(eq(marketplaceLoops.id, loopId))
		.limit(1)

	if (!loop) {
		return c.json(createApiError('NOT_FOUND', 'Marketplace loop not found'), 404)
	}

	const items = await db
		.select()
		.from(marketplaceLoopItems)
		.where(eq(marketplaceLoopItems.loopId, loopId))

	// 3. Pre-flight duplicate check. The (workspace_id, source_loop_id) unique
	//    index would catch this too, but a clean 409 is friendlier than a 500
	//    surfacing a pg error code.
	const existing = await db
		.select({ id: installedLoops.id })
		.from(installedLoops)
		.where(
			and(eq(installedLoops.workspaceId, workspaceId), eq(installedLoops.sourceLoopId, loopId)),
		)
		.limit(1)
	if (existing[0]) {
		return c.json(createApiError('CONFLICT', 'Loop is already installed in this workspace'), 409)
	}

	const provisioned = { actors: 0, triggers: 0, skills: 0, integrations: 0, extensions: 0 }

	let installed: typeof installedLoops.$inferSelect
	try {
		installed = await db.transaction(async (tx) => {
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
						const existing = await findProvisionedActorBySourceItem(
							tx,
							workspaceId,
							item.sourceItemId,
						)
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
								.values(
									buildSkillInsert(workspaceId, skillId, storageKey, snapshot, metadata, actorId),
								)
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
					case 'extension': {
						// Extensions provision no row — they're enabled by merging their
						// defaults into workspace settings. Nothing else in the loop can
						// be wired to one, so this stays out of `sourceToLocal`.
						// `changed: false` means the workspace already had the extension
						// enabled (by another loop, or as a workspace default) — a reuse,
						// not a provision, so it doesn't count.
						const { changed } = await applyExtensionSnapshot(tx, workspaceId, snapshot)
						if (changed) provisioned.extensions++
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
					status: 'running',
					createdBy: actorId,
					metadata: {
						installed_from_marketplace_loop_id: loopId,
						trigger_ids: provisionedTriggerIds,
					},
				})
				.returning()
			if (!loopObject) throw new Error('Failed to insert loop object for install')

			await tx
				.update(installedLoops)
				.set({ objectId: loopObject.id })
				.where(eq(installedLoops.id, installRow.id))

			await tx.insert(events).values({
				workspaceId,
				actorId,
				action: 'created',
				entityType: 'loop',
				entityId: loopObject.id,
				data: loopObject,
			})

			await tx.insert(events).values({
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

			return { ...installRow, objectId: loopObject.id }
		})
	} catch (err) {
		if (err instanceof SkillNameConflictError) {
			return c.json(
				createApiError(
					'CONFLICT',
					`${err.message} and could not be reconciled with the marketplace item automatically`,
				),
				409,
			)
		}
		throw err
	}

	// Auto-subscribe the installer to the new Loop object, same as manually
	// creating an object (see objects.ts's POST route). Outside the transaction
	// (mirrors that route) — a missed subscribe on a rare failure is not worth
	// widening the install transaction's lock footprint.
	if (installed.objectId) {
		await autoSubscribe(db, {
			workspaceId,
			actorId,
			entityType: 'object',
			entityId: installed.objectId,
			source: 'author',
		})
	}

	logger.info('Marketplace loop installed', {
		installedLoopId: installed.id,
		workspaceId,
		sourceLoopId: loopId,
		installedVersion: loop.version,
		objectId: installed.objectId,
		provisioned,
	})

	// Fire-and-forget the ship-metric emit. `trackLoopInstalled` swallows
	// failures internally — analytics gaps must never break the install.
	void trackLoopInstalled({
		loopId,
		loopSlug: loop.slug,
		loopVersion: loop.version,
		workspaceId,
		actorId,
		provisioned,
	})

	return c.json(
		{
			...serialize(installed),
			provisioned,
		},
		201,
	)
})

// ── POST /api/installed-loops/:id/fork ───────────────────────────────────────
//
// Detach a locked install so the workspace owns the provisioned elements. The
// install row is preserved (lineage) but flipped to `is_locked = false` with
// `forked_at = now()`; every actor/trigger/skill/integration row provisioned
// by the install has `metadata.installed_loop_id` removed so the T5 cron
// no longer treats them as managed. `metadata.source_item_id` (and the
// frozen `metadata.snapshot`) stay in place so the lineage from element back
// to marketplace item is still readable. The linked Loop object (and its
// `trigger_ids`) is untouched — forking only changes who owns the underlying
// elements, not the running loop.
//
// Idempotency: a 409 on an already-forked install. We intentionally do not
// silently no-op — the caller asked to fork something that is already forked,
// which usually means a stale UI state.

const forkResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	sourceLoopId: z.string().uuid(),
	objectId: z.string().uuid().nullable(),
	installedVersion: z.string(),
	isLocked: z.boolean(),
	forkedAt: z.string().nullable(),
	installedAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	detached: z.object({
		actors: z.number(),
		triggers: z.number(),
		skills: z.number(),
		integrations: z.number(),
	}),
	metadata: jsonbField.optional(),
})

const forkLoopRoute = createRoute({
	method: 'post',
	path: '/{id}/fork',
	tags: ['installed-loops'],
	summary: 'Fork an installed loop so the workspace owns its elements',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			description: 'Loop forked',
			content: { 'application/json': { schema: forkResponseSchema } },
		},
		400: {
			description: 'Validation error',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not a member of the install workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Installed loop not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Install is already forked',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(forkLoopRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	// 1. Look up the install. By-id route so the workspace comes off the row,
	//    not the header — we check membership against it next.
	const [install] = await db.select().from(installedLoops).where(eq(installedLoops.id, id)).limit(1)

	if (!install) {
		return c.json(createApiError('NOT_FOUND', 'Installed loop not found'), 404)
	}

	if (!(await isWorkspaceMember(db, actorId, install.workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'You are not a member of the install workspace'), 403)
	}

	// 2. A second fork is a no-op the caller probably didn't intend. Surface
	//    the stale state explicitly rather than silently re-stamping forked_at.
	if (!install.isLocked) {
		return c.json(createApiError('CONFLICT', 'Install is already forked'), 409)
	}

	const detached = { actors: 0, triggers: 0, skills: 0, integrations: 0 }

	const forked = await db.transaction(async (tx) => {
		const now = new Date()

		// 3. Flip the install row. Lineage (source_loop_id, installed_version)
		//    stays on the row — that's how the UI shows "forked from v1.4".
		//    The `is_locked = true` guard in the WHERE makes this the TOCTOU
		//    backstop for the pre-tx 409 check: if a concurrent fork has already
		//    flipped the row in the gap, our UPDATE matches zero rows and we bail
		//    out before writing any element-row detaches or the audit event row.
		const [row] = await tx
			.update(installedLoops)
			.set({ isLocked: false, forkedAt: now, updatedAt: now })
			.where(and(eq(installedLoops.id, install.id), eq(installedLoops.isLocked, true)))
			.returning()

		// Lost the race — another fork transaction committed first. Surface as 409
		// (same shape as the pre-tx isLocked check); the winning tx already wrote
		// the single audit event row.
		if (!row) return null

		// 4. Swap `installed_loop_id` → `forked_from_installed_loop_id` in each
		//    provisioned element's metadata. Removing `installed_loop_id` stops the
		//    T5 cron from treating these rows as managed. Keeping the install ID under
		//    a different key lets the uninstall route find and optionally delete these
		//    elements even after the fork. `source_item_id` and `snapshot` stay as-is.
		const detachClause = sql`(${actors.metadata} - 'installed_loop_id') || jsonb_build_object('forked_from_installed_loop_id', ${install.id}::text)`
		const actorRes = await tx
			.update(actors)
			.set({ metadata: detachClause })
			.where(sql`${actors.metadata}->>'installed_loop_id' = ${install.id}`)
			.returning({ id: actors.id })
		detached.actors = actorRes.length

		const triggerRes = await tx
			.update(triggers)
			.set({
				metadata: sql`(${triggers.metadata} - 'installed_loop_id') || jsonb_build_object('forked_from_installed_loop_id', ${install.id}::text)`,
			})
			.where(sql`${triggers.metadata}->>'installed_loop_id' = ${install.id}`)
			.returning({ id: triggers.id })
		detached.triggers = triggerRes.length

		const skillRes = await tx
			.update(workspaceSkills)
			.set({
				metadata: sql`(${workspaceSkills.metadata} - 'installed_loop_id') || jsonb_build_object('forked_from_installed_loop_id', ${install.id}::text)`,
			})
			.where(sql`${workspaceSkills.metadata}->>'installed_loop_id' = ${install.id}`)
			.returning({ id: workspaceSkills.id })
		detached.skills = skillRes.length

		const integrationRes = await tx
			.update(integrations)
			.set({
				metadata: sql`(${integrations.metadata} - 'installed_loop_id') || jsonb_build_object('forked_from_installed_loop_id', ${install.id}::text)`,
			})
			.where(sql`${integrations.metadata}->>'installed_loop_id' = ${install.id}`)
			.returning({ id: integrations.id })
		detached.integrations = integrationRes.length

		await tx.insert(events).values({
			workspaceId: row.workspaceId,
			actorId,
			action: 'forked',
			entityType: 'installed_loop',
			entityId: row.id,
			data: {
				source_loop_id: row.sourceLoopId,
				installed_version: row.installedVersion,
				detached,
			},
		})

		return row
	})

	if (!forked) {
		return c.json(createApiError('CONFLICT', 'Install is already forked'), 409)
	}

	logger.info('Installed loop forked', {
		installedLoopId: forked.id,
		workspaceId: forked.workspaceId,
		sourceLoopId: forked.sourceLoopId,
		installedVersion: forked.installedVersion,
		detached,
	})

	void trackLoopForked({
		loopId: forked.sourceLoopId,
		installedLoopId: forked.id,
		versionAtFork: forked.installedVersion,
		workspaceId: forked.workspaceId,
		actorId,
	})

	return c.json(
		{
			...serialize(forked),
			detached,
		},
		200,
	)
})

// ── DELETE /api/installed-loops/:id ──────────────────────────────────────────
//
// Remove an installed loop from the workspace.
//
// `keepProvisionedItems` (body boolean) controls what happens to the actors,
// triggers, skills, and integrations that were provisioned during install:
//
//   false — cascade-delete all provisioned elements, same as the actor delete
//           route for each provisioned agent plus explicit deletes for the
//           non-actor element types. The linked Loop object is deleted too —
//           its `trigger_ids` would otherwise point at rows that no longer
//           exist.
//
// Extensions are deliberately outside this: neither branch disables an
// extension the loop enabled. Disabling one hides every object of its types (a
// workspace that installed the Work Extension loop and later removed it would
// lose sight of all its insights/bets/tasks) — losing the objects is far worse
// than leaving an extension enabled, and nothing else about the uninstall is
// destructive to user data. Disabling an extension is an explicit
// `PATCH /workspaces/:id` on `settings.enabled_modules`.
//
//   true  — for locked (managed) installs: strip `installed_loop_id` from
//            all element metadata so they become workspace-owned (same outcome
//            as a fork, but the installed_loops row is also deleted).
//            For forked installs: elements are already detached; just remove
//            the tracking row. The linked Loop object is kept either way — it's
//            now a plain, user-owned Loop.

const uninstallLoopBodySchema = z.object({
	keepProvisionedItems: z.boolean(),
})

const uninstallResponseSchema = z.object({
	deleted: z.boolean(),
	removedElements: z
		.object({
			actors: z.number(),
			triggers: z.number(),
			skills: z.number(),
			integrations: z.number(),
		})
		.optional(),
	removedLoopObject: z.boolean(),
})

const uninstallLoopRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['installed-loops'],
	summary: 'Remove an installed loop from a workspace',
	request: {
		params: idParamSchema,
		body: {
			content: { 'application/json': { schema: uninstallLoopBodySchema } },
		},
	},
	responses: {
		200: {
			description: 'Loop removed',
			content: { 'application/json': { schema: uninstallResponseSchema } },
		},
		400: {
			description: 'Validation error',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not a member of the install workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Installed loop not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(uninstallLoopRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const agentStorage = c.get('agentStorage')
	const { id } = c.req.valid('param')
	const { keepProvisionedItems } = c.req.valid('json')

	const [install] = await db.select().from(installedLoops).where(eq(installedLoops.id, id)).limit(1)

	if (!install) {
		return c.json(createApiError('NOT_FOUND', 'Installed loop not found'), 404)
	}

	if (!(await isWorkspaceMember(db, actorId, install.workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'You are not a member of the install workspace'), 403)
	}

	let removedElements:
		| { actors: number; triggers: number; skills: number; integrations: number }
		| undefined
	// Ids of workspace_skills rows deleted below, cleaned up from S3 after the
	// tx commits (DB row is the source of truth; an orphan S3 object left by a
	// failed post-commit delete is inert — see workspace-skills.ts's DELETE route).
	let removedSkillIds: string[] = []
	let removedLoopObject = false

	await db.transaction(async (tx) => {
		if (keepProvisionedItems) {
			// Strip both `installed_loop_id` (managed) and `forked_from_installed_loop_id`
			// (forked) from element metadata so elements become plain workspace resources.
			// The WHERE covers both managed installs (which still have `installed_loop_id`)
			// and forked installs (which carry `forked_from_installed_loop_id` instead).
			await tx
				.update(actors)
				.set({
					metadata: sql`${actors.metadata} - 'installed_loop_id' - 'forked_from_installed_loop_id'`,
				})
				.where(
					sql`${actors.metadata}->>'installed_loop_id' = ${install.id} OR ${actors.metadata}->>'forked_from_installed_loop_id' = ${install.id}`,
				)
			await tx
				.update(triggers)
				.set({
					metadata: sql`${triggers.metadata} - 'installed_loop_id' - 'forked_from_installed_loop_id'`,
				})
				.where(
					sql`${triggers.metadata}->>'installed_loop_id' = ${install.id} OR ${triggers.metadata}->>'forked_from_installed_loop_id' = ${install.id}`,
				)
			await tx
				.update(workspaceSkills)
				.set({
					metadata: sql`${workspaceSkills.metadata} - 'installed_loop_id' - 'forked_from_installed_loop_id'`,
				})
				.where(
					sql`${workspaceSkills.metadata}->>'installed_loop_id' = ${install.id} OR ${workspaceSkills.metadata}->>'forked_from_installed_loop_id' = ${install.id}`,
				)
			await tx
				.update(integrations)
				.set({
					metadata: sql`${integrations.metadata} - 'installed_loop_id' - 'forked_from_installed_loop_id'`,
				})
				.where(
					sql`${integrations.metadata}->>'installed_loop_id' = ${install.id} OR ${integrations.metadata}->>'forked_from_installed_loop_id' = ${install.id}`,
				)
		} else {
			// Cascade-delete all provisioned elements.
			// Match by `installed_loop_id` (managed) or `forked_from_installed_loop_id` (forked)
			// so both managed and forked removals work correctly.

			// Delete non-actor elements by metadata first (triggers, skills, integrations).
			const triggerRes = await tx
				.delete(triggers)
				.where(
					sql`${triggers.metadata}->>'installed_loop_id' = ${install.id} OR ${triggers.metadata}->>'forked_from_installed_loop_id' = ${install.id}`,
				)
				.returning({ id: triggers.id })

			// Shared skills (bundled by more than one installed loop, matched by
			// source_item_id or by name) survive this uninstall — rehomed to a live
			// install that still references them — mirroring the actor partition
			// below. Only the unreferenced remainder is deleted.
			const provisionedSkillRows = await tx
				.select({
					id: workspaceSkills.id,
					name: workspaceSkills.name,
					metadata: workspaceSkills.metadata,
				})
				.from(workspaceSkills)
				.where(
					sql`${workspaceSkills.metadata}->>'installed_loop_id' = ${install.id} OR ${workspaceSkills.metadata}->>'forked_from_installed_loop_id' = ${install.id}`,
				)
			const { deleted: deletedSkillIds, kept: keptSkillIds } = await partitionProvisionedSkills(
				tx,
				install.workspaceId,
				install.id,
				provisionedSkillRows.map((r) => ({
					id: r.id,
					sourceItemId: sourceItemIdOf(r.metadata),
					name: r.name,
				})),
			)
			if (keptSkillIds.length > 0) {
				logger.info(
					'Kept shared skills on uninstall — another installed loop still references them',
					{
						installId: install.id,
						workspaceId: install.workspaceId,
						keptSkillIds,
					},
				)
			}
			if (deletedSkillIds.length > 0) {
				await tx.delete(workspaceSkills).where(inArray(workspaceSkills.id, deletedSkillIds))
			}
			removedSkillIds = deletedSkillIds

			const integrationRes = await tx
				.delete(integrations)
				.where(
					sql`${integrations.metadata}->>'installed_loop_id' = ${install.id} OR ${integrations.metadata}->>'forked_from_installed_loop_id' = ${install.id}`,
				)
				.returning({ id: integrations.id })

			// Find provisioned actor IDs. A shared agent — one another installed
			// loop still references — survives this uninstall (see
			// partitionProvisionedActors); only the rows nothing else uses are
			// cascade-deleted below, so a surviving loop's triggers keep firing.
			const provisionedActorRows = await tx
				.select({ id: actors.id, metadata: actors.metadata })
				.from(actors)
				.where(
					sql`${actors.metadata}->>'installed_loop_id' = ${install.id} OR ${actors.metadata}->>'forked_from_installed_loop_id' = ${install.id}`,
				)

			const { deleted: actorIds, kept: keptActorIds } = await partitionProvisionedActors(
				tx,
				install.workspaceId,
				install.id,
				provisionedActorRows.map((r) => ({ id: r.id, sourceItemId: sourceItemIdOf(r.metadata) })),
			)
			if (keptActorIds.length > 0) {
				logger.info(
					'Kept shared agents on uninstall — another installed loop still references them',
					{
						installId: install.id,
						workspaceId: install.workspaceId,
						keptActorIds,
					},
				)
			}

			if (actorIds.length > 0) {
				// Delete triggers that target or were created by provisioned actors.
				// The metadata-based delete above only removed marketplace-managed triggers;
				// user-created triggers pointing at the same agents must also go before
				// the actors are deleted or we risk an FK violation.
				await tx
					.delete(triggers)
					.where(
						or(inArray(triggers.targetActorId, actorIds), inArray(triggers.createdBy, actorIds)),
					)

				// Delete session logs for sessions owned by provisioned actors.
				const actorSessions = await tx
					.select({ id: sessions.id })
					.from(sessions)
					.where(inArray(sessions.actorId, actorIds))
				const sessionIds = actorSessions.map((s) => s.id)
				if (sessionIds.length > 0) {
					await tx.delete(sessionLogs).where(inArray(sessionLogs.sessionId, sessionIds))
				}
				await tx.delete(sessions).where(inArray(sessions.actorId, actorIds))
				// Reassign sessions created by provisioned actors.
				await tx
					.update(sessions)
					.set({ createdBy: actorId })
					.where(inArray(sessions.createdBy, actorIds))

				// Cascade-delete remaining actor data.
				await tx.delete(agentFiles).where(inArray(agentFiles.actorId, actorIds))
				await tx
					.delete(notifications)
					.where(
						or(
							inArray(notifications.sourceActorId, actorIds),
							inArray(notifications.targetActorId, actorIds),
						),
					)
				await tx.delete(events).where(inArray(events.actorId, actorIds))
				await tx.delete(relationships).where(inArray(relationships.createdBy, actorIds))
				await tx.delete(subscriptions).where(inArray(subscriptions.actorId, actorIds))
				await tx.delete(readState).where(inArray(readState.actorId, actorIds))

				// Reassign objects/files/imports/skills/workspaces/integrations.
				await tx.update(objects).set({ driver: null }).where(inArray(objects.driver, actorIds))
				await tx
					.update(objects)
					.set({ createdBy: actorId })
					.where(inArray(objects.createdBy, actorIds))
				await tx.update(files).set({ createdBy: actorId }).where(inArray(files.createdBy, actorIds))
				await tx
					.update(imports)
					.set({ createdBy: actorId })
					.where(inArray(imports.createdBy, actorIds))
				await tx
					.update(workspaceSkills)
					.set({ createdBy: null })
					.where(inArray(workspaceSkills.createdBy, actorIds))
				await tx
					.update(workspaces)
					.set({ createdBy: null })
					.where(inArray(workspaces.createdBy, actorIds))
				await tx
					.update(integrations)
					.set({ createdBy: actorId })
					.where(inArray(integrations.createdBy, actorIds))

				// Null out self-referential createdBy on actors, then delete.
				for (const aid of actorIds) {
					await tx.update(actors).set({ createdBy: null }).where(eq(actors.createdBy, aid))
				}
				await tx.delete(workspaceMembers).where(inArray(workspaceMembers.actorId, actorIds))
				await tx.delete(actors).where(inArray(actors.id, actorIds))
			}

			removedElements = {
				actors: actorIds.length,
				triggers: triggerRes.length,
				skills: deletedSkillIds.length,
				integrations: integrationRes.length,
			}
		}

		// Delete the installed_loops tracking row. Must come before the linked
		// Loop object is deleted below — `installed_loops.object_id` has an FK to
		// `objects.id`, so deleting the object first fails with a 23503.
		await tx.delete(installedLoops).where(eq(installedLoops.id, install.id))

		// Delete the linked Loop object — its trigger_ids would otherwise
		// dangle. Relationships pointing at it are cleared first to avoid
		// leaving an orphaned edge (comments/events are an audit log and are
		// left in place, same as everywhere else objects are deleted).
		if (!keepProvisionedItems && install.objectId) {
			await tx
				.delete(relationships)
				.where(
					or(
						eq(relationships.sourceId, install.objectId),
						eq(relationships.targetId, install.objectId),
					),
				)
			await tx
				.delete(subscriptions)
				.where(
					and(eq(subscriptions.entityType, 'object'), eq(subscriptions.entityId, install.objectId)),
				)
			await tx
				.delete(readState)
				.where(and(eq(readState.entityType, 'object'), eq(readState.entityId, install.objectId)))
			await tx.delete(objects).where(eq(objects.id, install.objectId))
			removedLoopObject = true
		}

		await tx.insert(events).values({
			workspaceId: install.workspaceId,
			actorId,
			action: 'deleted',
			entityType: 'installed_loop',
			entityId: install.id,
			data: {
				source_loop_id: install.sourceLoopId,
				installed_version: install.installedVersion,
				kept_items: keepProvisionedItems,
				removed_elements: removedElements ?? null,
				removed_loop_object: removedLoopObject,
			},
		})
	})

	for (const skillId of removedSkillIds) {
		try {
			await agentStorage.deleteWorkspaceSkill(install.workspaceId, skillId)
		} catch (err) {
			logger.error('Failed to delete workspace skill from storage (orphan object left)', {
				workspaceId: install.workspaceId,
				skillId,
				error: String(err),
			})
		}
	}

	logger.info('Installed loop removed', {
		installedLoopId: install.id,
		workspaceId: install.workspaceId,
		sourceLoopId: install.sourceLoopId,
		keepProvisionedItems,
		removedElements,
		removedLoopObject,
	})

	void trackLoopUninstalled({
		loopId: install.sourceLoopId,
		installedLoopId: install.id,
		workspaceId: install.workspaceId,
		actorId,
		keptItems: keepProvisionedItems,
	})

	return c.json({ deleted: true, removedElements, removedLoopObject }, 200)
})

export default app
