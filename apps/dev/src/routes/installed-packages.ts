import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	catalogPackageItems,
	catalogPackages,
	installedPackages,
	integrations,
	triggers,
	workspaceSkills,
} from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
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

		// 4. Drop `installed_package_id` from each provisioned element's metadata.
		//    Postgres `jsonb - 'key'` removes the top-level key in place; the
		//    `source_item_id` and frozen `snapshot` keys stay so element → catalog
		//    item lineage remains queryable post-fork. The T5 cron's locked-install
		//    join keys on `installed_package_id`, so clearing it here is what
		//    actually unmanages these rows.
		const detachClause = sql`${actors.metadata} - 'installed_package_id'`
		const actorRes = await tx
			.update(actors)
			.set({ metadata: detachClause })
			.where(sql`${actors.metadata}->>'installed_package_id' = ${install.id}`)
			.returning({ id: actors.id })
		detached.actors = actorRes.length

		const triggerRes = await tx
			.update(triggers)
			.set({ metadata: sql`${triggers.metadata} - 'installed_package_id'` })
			.where(sql`${triggers.metadata}->>'installed_package_id' = ${install.id}`)
			.returning({ id: triggers.id })
		detached.triggers = triggerRes.length

		const skillRes = await tx
			.update(workspaceSkills)
			.set({ metadata: sql`${workspaceSkills.metadata} - 'installed_package_id'` })
			.where(sql`${workspaceSkills.metadata}->>'installed_package_id' = ${install.id}`)
			.returning({ id: workspaceSkills.id })
		detached.skills = skillRes.length

		const integrationRes = await tx
			.update(integrations)
			.set({ metadata: sql`${integrations.metadata} - 'installed_package_id'` })
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

	return c.json(
		{
			...serialize(forked),
			detached,
		},
		200,
	)
})

export default app
