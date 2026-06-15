import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	agentFiles,
	catalogPackageItems,
	catalogPackages,
	files,
	imports,
	installedPackages,
	integrations,
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
	trackPackageForked,
	trackPackageInstalled,
	trackPackageUninstalled,
} from '../lib/analytics/catalog-events'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, jsonbField } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'
import {
	type CatalogItemType,
	buildActorInsert,
	buildIntegrationInsert,
	buildSkillInsert,
	buildTriggerInsert,
	installMetadata,
	rewriteWiring,
} from '../services/package-provisioning'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

const installPackageBodySchema = z.object({
	packageId: z.string().uuid(),
	workspaceId: z.string().uuid(),
})

const listInstalledPackagesQuerySchema = z.object({
	workspaceId: z.string().uuid(),
})

const installedPackageRowSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	sourcePackageId: z.string().uuid(),
	installedVersion: z.string(),
	isLocked: z.boolean(),
	forkedAt: z.string().nullable(),
	installedAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	availableVersion: z.string(),
	hasUpdate: z.boolean(),
	packageName: z.string(),
})

const listInstalledPackagesResponseSchema = z.object({
	installs: z.array(installedPackageRowSchema),
})

const installedPackageResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	sourcePackageId: z.string().uuid(),
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
	}),
	metadata: jsonbField.optional(),
})

// GET /api/installed-packages?workspaceId=… — list the workspace's installs.
//
// Joins on catalog_packages so each row carries the current published version
// alongside the installed version, plus a derived `hasUpdate` flag. The
// marketplace UI uses this to render the badge state (managed / forked) and
// the amber update banner on locked rows whose installed_version trails the
// catalog version (the T5 cron normally closes this gap within an hour, but
// the gap is real between cron ticks and we want the user to see it).
const listInstalledPackagesRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['installed-packages'],
	summary: 'List installed packages for a workspace',
	request: {
		query: listInstalledPackagesQuerySchema,
	},
	responses: {
		200: {
			description: 'Installed packages with current catalog version',
			content: { 'application/json': { schema: listInstalledPackagesResponseSchema } },
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

app.openapi(listInstalledPackagesRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { workspaceId } = c.req.valid('query')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'You are not a member of the target workspace'), 403)
	}

	const rows = await db
		.select({
			id: installedPackages.id,
			workspaceId: installedPackages.workspaceId,
			sourcePackageId: installedPackages.sourcePackageId,
			installedVersion: installedPackages.installedVersion,
			isLocked: installedPackages.isLocked,
			forkedAt: installedPackages.forkedAt,
			installedAt: installedPackages.installedAt,
			updatedAt: installedPackages.updatedAt,
			availableVersion: catalogPackages.version,
			packageName: catalogPackages.name,
		})
		.from(installedPackages)
		.innerJoin(catalogPackages, eq(catalogPackages.id, installedPackages.sourcePackageId))
		.where(eq(installedPackages.workspaceId, workspaceId))

	return c.json(
		{
			installs: rows.map((row) => ({
				...serialize(row),
				availableVersion: row.availableVersion,
				hasUpdate: row.installedVersion !== row.availableVersion,
				packageName: row.packageName,
			})),
		},
		200,
	)
})

// POST /api/installed-packages — provision a catalog package into a workspace.
//
// Locked install (is_locked = true): Maskin owns the install and the version-push
// cron (T5) keeps it in sync. The caller can fork later via T4 to detach.
const installPackageRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['installed-packages'],
	summary: 'Install a catalog package into a workspace',
	request: {
		body: {
			content: { 'application/json': { schema: installPackageBodySchema } },
		},
	},
	responses: {
		201: {
			description: 'Package installed',
			content: { 'application/json': { schema: installedPackageResponseSchema } },
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
			description: 'Catalog package not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Package already installed in this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(installPackageRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { packageId, workspaceId } = c.req.valid('json')

	// 1. Caller must belong to the target workspace. We check resource-scoped
	//    membership here rather than via the workspace-id header because the
	//    workspace is part of the install body, not the request envelope.
	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'You are not a member of the target workspace'), 403)
	}

	// 2. Resolve the package + its frozen items. A package with zero items is
	//    legal — it installs an empty `installed_packages` row that the cron
	//    will catch up on the next push if the publisher adds items.
	const [pkg] = await db
		.select()
		.from(catalogPackages)
		.where(eq(catalogPackages.id, packageId))
		.limit(1)

	if (!pkg) {
		return c.json(createApiError('NOT_FOUND', 'Catalog package not found'), 404)
	}

	const items = await db
		.select()
		.from(catalogPackageItems)
		.where(eq(catalogPackageItems.packageId, packageId))

	// 3. Pre-flight duplicate check. The (workspace_id, source_package_id) unique
	//    index would catch this too, but a clean 409 is friendlier than a 500
	//    surfacing a pg error code.
	const existing = await db
		.select({ id: installedPackages.id })
		.from(installedPackages)
		.where(
			and(
				eq(installedPackages.workspaceId, workspaceId),
				eq(installedPackages.sourcePackageId, packageId),
			),
		)
		.limit(1)
	if (existing[0]) {
		return c.json(createApiError('CONFLICT', 'Package is already installed in this workspace'), 409)
	}

	const provisioned = { actors: 0, triggers: 0, skills: 0, integrations: 0 }

	const installed = await db.transaction(async (tx) => {
		const [installRow] = await tx
			.insert(installedPackages)
			.values({
				workspaceId,
				sourcePackageId: packageId,
				installedVersion: pkg.version,
				isLocked: true,
			})
			.returning()

		if (!installRow) throw new Error('Failed to insert installed_packages row')

		// 4. Two-pass provisioning so triggers can reference any actor in the same
		//    package even when the actor is inserted later in the catalog ordering.
		//
		//    Pass 1: insert every item, capturing source_item_id → new_local_id.
		//    Triggers go last so their `target_actor_id` (which the snapshot
		//    expresses as a source id) can be rewritten against the now-complete
		//    map. We can't insert a trigger without a real target_actor_id (FK
		//    NOT NULL), so the pre-pass + ordering is load-bearing.
		const sourceToLocal = new Map<string, string>()

		const triggerItems: Array<{ sourceItemId: string; snapshot: Record<string, unknown> }> = []

		for (const item of items) {
			const type = item.itemType as CatalogItemType
			const snapshot = (item.itemSnapshot as Record<string, unknown>) ?? {}
			const metadata = installMetadata(installRow.id, item.sourceItemId, snapshot)

			switch (type) {
				case 'actor': {
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
					// Mirrors how the seeded Sindre agent is added on workspace creation.
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
					const [row] = await tx
						.insert(workspaceSkills)
						.values(buildSkillInsert(workspaceId, snapshot, metadata, actorId))
						.returning({ id: workspaceSkills.id })
					if (!row) throw new Error(`insert returned no row for skill ${item.sourceItemId}`)
					sourceToLocal.set(item.sourceItemId, row.id)
					provisioned.skills++
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

		for (const { sourceItemId, snapshot } of triggerItems) {
			const rewritten = rewriteWiring(snapshot, sourceToLocal)
			const metadata = installMetadata(installRow.id, sourceItemId, rewritten)
			const [row] = await tx
				.insert(triggers)
				.values(buildTriggerInsert(workspaceId, rewritten, metadata, actorId))
				.returning({ id: triggers.id })
			if (!row) throw new Error(`insert returned no row for trigger ${sourceItemId}`)
			sourceToLocal.set(sourceItemId, row.id)
			provisioned.triggers++
		}

		await tx.insert(events).values({
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'installed_package',
			entityId: installRow.id,
			data: {
				source_package_id: packageId,
				installed_version: pkg.version,
				items: provisioned,
			},
		})

		return installRow
	})

	logger.info('Catalog package installed', {
		installedPackageId: installed.id,
		workspaceId,
		sourcePackageId: packageId,
		installedVersion: pkg.version,
		provisioned,
	})

	// Fire-and-forget the ship-metric emit. `trackPackageInstalled` swallows
	// failures internally — analytics gaps must never break the install.
	void trackPackageInstalled({
		packageId,
		packageSlug: pkg.slug,
		packageVersion: pkg.version,
		workspaceId,
		actorId,
	})

	return c.json(
		{
			...serialize(installed),
			provisioned,
		},
		201,
	)
})

// ── POST /api/installed-packages/:id/fork ────────────────────────────────────
//
// Detach a locked install so the workspace owns the provisioned elements. The
// install row is preserved (lineage) but flipped to `is_locked = false` with
// `forked_at = now()`; every actor/trigger/skill/integration row provisioned
// by the install has `metadata.installed_package_id` removed so the T5 cron
// no longer treats them as managed. `metadata.source_item_id` (and the
// frozen `metadata.snapshot`) stay in place so the lineage from element back
// to catalog item is still readable.
//
// Idempotency: a 409 on an already-forked install. We intentionally do not
// silently no-op — the caller asked to fork something that is already forked,
// which usually means a stale UI state.

const forkResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	sourcePackageId: z.string().uuid(),
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

const forkPackageRoute = createRoute({
	method: 'post',
	path: '/{id}/fork',
	tags: ['installed-packages'],
	summary: 'Fork an installed package so the workspace owns its elements',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			description: 'Package forked',
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
			description: 'Installed package not found',
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

app.openapi(forkPackageRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	// 1. Look up the install. By-id route so the workspace comes off the row,
	//    not the header — we check membership against it next.
	const [install] = await db
		.select()
		.from(installedPackages)
		.where(eq(installedPackages.id, id))
		.limit(1)

	if (!install) {
		return c.json(createApiError('NOT_FOUND', 'Installed package not found'), 404)
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

		// 3. Flip the install row. Lineage (source_package_id, installed_version)
		//    stays on the row — that's how the UI shows "forked from v1.4".
		//    The `is_locked = true` guard in the WHERE makes this the TOCTOU
		//    backstop for the pre-tx 409 check: if a concurrent fork has already
		//    flipped the row in the gap, our UPDATE matches zero rows and we bail
		//    out before writing any element-row detaches or the audit event row.
		const [row] = await tx
			.update(installedPackages)
			.set({ isLocked: false, forkedAt: now, updatedAt: now })
			.where(and(eq(installedPackages.id, install.id), eq(installedPackages.isLocked, true)))
			.returning()

		// Lost the race — another fork transaction committed first. Surface as 409
		// (same shape as the pre-tx isLocked check); the winning tx already wrote
		// the single audit event row.
		if (!row) return null

		// 4. Swap `installed_package_id` → `forked_from_installed_package_id` in each
		//    provisioned element's metadata. Removing `installed_package_id` stops the
		//    T5 cron from treating these rows as managed. Keeping the install ID under
		//    a different key lets the uninstall route find and optionally delete these
		//    elements even after the fork. `source_item_id` and `snapshot` stay as-is.
		const detachClause = sql`(${actors.metadata} - 'installed_package_id') || jsonb_build_object('forked_from_installed_package_id', ${install.id}::text)`
		const actorRes = await tx
			.update(actors)
			.set({ metadata: detachClause })
			.where(sql`${actors.metadata}->>'installed_package_id' = ${install.id}`)
			.returning({ id: actors.id })
		detached.actors = actorRes.length

		const triggerRes = await tx
			.update(triggers)
			.set({
				metadata: sql`(${triggers.metadata} - 'installed_package_id') || jsonb_build_object('forked_from_installed_package_id', ${install.id}::text)`,
			})
			.where(sql`${triggers.metadata}->>'installed_package_id' = ${install.id}`)
			.returning({ id: triggers.id })
		detached.triggers = triggerRes.length

		const skillRes = await tx
			.update(workspaceSkills)
			.set({
				metadata: sql`(${workspaceSkills.metadata} - 'installed_package_id') || jsonb_build_object('forked_from_installed_package_id', ${install.id}::text)`,
			})
			.where(sql`${workspaceSkills.metadata}->>'installed_package_id' = ${install.id}`)
			.returning({ id: workspaceSkills.id })
		detached.skills = skillRes.length

		const integrationRes = await tx
			.update(integrations)
			.set({
				metadata: sql`(${integrations.metadata} - 'installed_package_id') || jsonb_build_object('forked_from_installed_package_id', ${install.id}::text)`,
			})
			.where(sql`${integrations.metadata}->>'installed_package_id' = ${install.id}`)
			.returning({ id: integrations.id })
		detached.integrations = integrationRes.length

		await tx.insert(events).values({
			workspaceId: row.workspaceId,
			actorId,
			action: 'forked',
			entityType: 'installed_package',
			entityId: row.id,
			data: {
				source_package_id: row.sourcePackageId,
				installed_version: row.installedVersion,
				detached,
			},
		})

		return row
	})

	if (!forked) {
		return c.json(createApiError('CONFLICT', 'Install is already forked'), 409)
	}

	logger.info('Installed package forked', {
		installedPackageId: forked.id,
		workspaceId: forked.workspaceId,
		sourcePackageId: forked.sourcePackageId,
		installedVersion: forked.installedVersion,
		detached,
	})

	void trackPackageForked({
		packageId: forked.sourcePackageId,
		installedPackageId: forked.id,
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

// ── DELETE /api/installed-packages/:id ───────────────────────────────────────
//
// Remove an installed package from the workspace.
//
// `keepProvisionedItems` (body boolean) controls what happens to the actors,
// triggers, skills, and integrations that were provisioned during install:
//
//   false — cascade-delete all provisioned elements, same as the actor delete
//           route for each provisioned agent plus explicit deletes for the
//           non-actor element types.
//
//   true  — for locked (managed) installs: strip `installed_package_id` from
//            all element metadata so they become workspace-owned (same outcome
//            as a fork, but the installed_packages row is also deleted).
//            For forked installs: elements are already detached; just remove
//            the tracking row.

const uninstallPackageBodySchema = z.object({
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
})

const uninstallPackageRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['installed-packages'],
	summary: 'Remove an installed package from a workspace',
	request: {
		params: idParamSchema,
		body: {
			content: { 'application/json': { schema: uninstallPackageBodySchema } },
		},
	},
	responses: {
		200: {
			description: 'Package removed',
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
			description: 'Installed package not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(uninstallPackageRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { keepProvisionedItems } = c.req.valid('json')

	const [install] = await db
		.select()
		.from(installedPackages)
		.where(eq(installedPackages.id, id))
		.limit(1)

	if (!install) {
		return c.json(createApiError('NOT_FOUND', 'Installed package not found'), 404)
	}

	if (!(await isWorkspaceMember(db, actorId, install.workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'You are not a member of the install workspace'), 403)
	}

	let removedElements:
		| { actors: number; triggers: number; skills: number; integrations: number }
		| undefined

	await db.transaction(async (tx) => {
		if (keepProvisionedItems) {
			// Strip both `installed_package_id` (managed) and `forked_from_installed_package_id`
			// (forked) from element metadata so elements become plain workspace resources.
			// The WHERE covers both managed installs (which still have `installed_package_id`)
			// and forked installs (which carry `forked_from_installed_package_id` instead).
			await tx
				.update(actors)
				.set({
					metadata: sql`${actors.metadata} - 'installed_package_id' - 'forked_from_installed_package_id'`,
				})
				.where(
					sql`${actors.metadata}->>'installed_package_id' = ${install.id} OR ${actors.metadata}->>'forked_from_installed_package_id' = ${install.id}`,
				)
			await tx
				.update(triggers)
				.set({
					metadata: sql`${triggers.metadata} - 'installed_package_id' - 'forked_from_installed_package_id'`,
				})
				.where(
					sql`${triggers.metadata}->>'installed_package_id' = ${install.id} OR ${triggers.metadata}->>'forked_from_installed_package_id' = ${install.id}`,
				)
			await tx
				.update(workspaceSkills)
				.set({
					metadata: sql`${workspaceSkills.metadata} - 'installed_package_id' - 'forked_from_installed_package_id'`,
				})
				.where(
					sql`${workspaceSkills.metadata}->>'installed_package_id' = ${install.id} OR ${workspaceSkills.metadata}->>'forked_from_installed_package_id' = ${install.id}`,
				)
			await tx
				.update(integrations)
				.set({
					metadata: sql`${integrations.metadata} - 'installed_package_id' - 'forked_from_installed_package_id'`,
				})
				.where(
					sql`${integrations.metadata}->>'installed_package_id' = ${install.id} OR ${integrations.metadata}->>'forked_from_installed_package_id' = ${install.id}`,
				)
		} else {
			// Cascade-delete all provisioned elements.
			// Match by `installed_package_id` (managed) or `forked_from_installed_package_id` (forked)
			// so both managed and forked removals work correctly.

			// Delete non-actor elements by metadata first (triggers, skills, integrations).
			const triggerRes = await tx
				.delete(triggers)
				.where(
					sql`${triggers.metadata}->>'installed_package_id' = ${install.id} OR ${triggers.metadata}->>'forked_from_installed_package_id' = ${install.id}`,
				)
				.returning({ id: triggers.id })

			const skillRes = await tx
				.delete(workspaceSkills)
				.where(
					sql`${workspaceSkills.metadata}->>'installed_package_id' = ${install.id} OR ${workspaceSkills.metadata}->>'forked_from_installed_package_id' = ${install.id}`,
				)
				.returning({ id: workspaceSkills.id })

			const integrationRes = await tx
				.delete(integrations)
				.where(
					sql`${integrations.metadata}->>'installed_package_id' = ${install.id} OR ${integrations.metadata}->>'forked_from_installed_package_id' = ${install.id}`,
				)
				.returning({ id: integrations.id })

			// Find provisioned actor IDs.
			const provisionedActorRows = await tx
				.select({ id: actors.id })
				.from(actors)
				.where(
					sql`${actors.metadata}->>'installed_package_id' = ${install.id} OR ${actors.metadata}->>'forked_from_installed_package_id' = ${install.id}`,
				)

			const actorIds = provisionedActorRows.map((r) => r.id)

			if (actorIds.length > 0) {
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
				skills: skillRes.length,
				integrations: integrationRes.length,
			}
		}

		// Delete the installed_packages tracking row.
		await tx.delete(installedPackages).where(eq(installedPackages.id, install.id))

		await tx.insert(events).values({
			workspaceId: install.workspaceId,
			actorId,
			action: 'deleted',
			entityType: 'installed_package',
			entityId: install.id,
			data: {
				source_package_id: install.sourcePackageId,
				installed_version: install.installedVersion,
				kept_items: keepProvisionedItems,
				removed_elements: removedElements ?? null,
			},
		})
	})

	logger.info('Installed package removed', {
		installedPackageId: install.id,
		workspaceId: install.workspaceId,
		sourcePackageId: install.sourcePackageId,
		keepProvisionedItems,
		removedElements,
	})

	void trackPackageUninstalled({
		packageId: install.sourcePackageId,
		installedPackageId: install.id,
		workspaceId: install.workspaceId,
		actorId,
		keptItems: keepProvisionedItems,
	})

	return c.json({ deleted: true, removedElements }, 200)
})

export default app
