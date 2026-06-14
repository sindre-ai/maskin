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
import { and, eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, jsonbField } from '../lib/openapi-schemas'
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

export default app
