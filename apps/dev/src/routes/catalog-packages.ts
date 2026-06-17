import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	type CatalogPackage,
	type CatalogPackageItem,
	actors,
	agentFiles,
	catalogPackageItems,
	catalogPackages,
	files,
	imports,
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
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, jsonbField } from '../lib/openapi-schemas'
import { isWorkspaceMember } from '../lib/workspace-auth'
import {
	type CatalogItemType,
	buildActorInsert,
	buildIntegrationInsert,
	buildSkillInsert,
	buildTriggerInsert,
} from '../services/package-provisioning'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>()

// The catalog itself is global — packages aren't scoped to any workspace.
// Routes are mounted behind the API-key auth middleware in app-factory; no
// per-workspace membership check is needed (and an X-Workspace-Id header is
// not required because the catalog reads identically for every caller).

const ITEM_TYPES = ['actor', 'trigger', 'skill', 'integration'] as const
type ItemType = (typeof ITEM_TYPES)[number]

// ── Response schemas ──────────────────────────────────────────────────────────

const itemTypeSchema = z.enum(ITEM_TYPES)

const packageSummarySchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	slug: z.string(),
	description: z.string(),
	version: z.string(),
	use_case: z.string().nullable(),
	category: z.string().nullable(),
	item_types: z.array(itemTypeSchema),
	created_at: z.string().nullable(),
	updated_at: z.string().nullable(),
})

const countsSchema = z.object({
	total: z.number(),
	by_type: z.object({
		actor: z.number(),
		trigger: z.number(),
		skill: z.number(),
		integration: z.number(),
	}),
	by_use_case: z.record(z.string(), z.number()),
})

const listPackagesResponseSchema = z.object({
	packages: z.array(packageSummarySchema),
	counts: countsSchema,
})

const packageItemSchema = z.object({
	id: z.string().uuid(),
	package_id: z.string().uuid(),
	item_type: itemTypeSchema,
	source_item_id: z.string().uuid(),
	item_snapshot: jsonbField,
	created_at: z.string().nullable(),
})

const packageDetailResponseSchema = z.object({
	package: packageSummarySchema,
	items: z.array(packageItemSchema),
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function isItemType(value: string): value is ItemType {
	return (ITEM_TYPES as readonly string[]).includes(value)
}

function isoOrNull(value: Date | null | undefined): string | null {
	return value instanceof Date ? value.toISOString() : (value ?? null)
}

function toPackageSummary(
	row: CatalogPackage,
	itemTypes: ItemType[],
): z.infer<typeof packageSummarySchema> {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		version: row.version,
		use_case: row.useCase,
		category: row.category,
		item_types: itemTypes,
		created_at: isoOrNull(row.createdAt),
		updated_at: isoOrNull(row.updatedAt),
	}
}

function toPackageItem(row: CatalogPackageItem): z.infer<typeof packageItemSchema> {
	return {
		id: row.id,
		package_id: row.packageId,
		item_type: row.itemType as ItemType,
		source_item_id: row.sourceItemId,
		item_snapshot: row.itemSnapshot as z.infer<typeof jsonbField>,
		created_at: isoOrNull(row.createdAt),
	}
}

async function loadItemTypesByPackage(
	db: Database,
	packageIds: string[],
): Promise<Map<string, ItemType[]>> {
	if (packageIds.length === 0) return new Map()
	const rows = await db
		.selectDistinct({
			packageId: catalogPackageItems.packageId,
			itemType: catalogPackageItems.itemType,
		})
		.from(catalogPackageItems)
		.where(inArray(catalogPackageItems.packageId, packageIds))

	const byPackage = new Map<string, ItemType[]>()
	for (const row of rows) {
		if (!isItemType(row.itemType)) continue
		const existing = byPackage.get(row.packageId) ?? []
		existing.push(row.itemType)
		byPackage.set(row.packageId, existing)
	}
	for (const list of byPackage.values()) list.sort()
	return byPackage
}

// ── GET /api/catalog/packages ─────────────────────────────────────────────────

const listQuerySchema = z.object({
	type: itemTypeSchema.optional(),
	use_case: z.string().min(1).max(200).optional(),
	q: z.string().min(1).max(200).optional(),
})

const listPackagesRoute = createRoute({
	method: 'get',
	path: '/packages',
	tags: ['Catalog'],
	summary: 'List managed catalog packages with sidebar counts',
	request: {
		query: listQuerySchema,
	},
	responses: {
		200: {
			description: 'Packages matching the filters plus full-catalog counts for the sidebar.',
			content: { 'application/json': { schema: listPackagesResponseSchema } },
		},
		400: {
			description: 'Invalid query parameter',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listPackagesRoute, (async (c) => {
	const db = c.get('db')
	const { type, use_case, q } = c.req.valid('query')

	// Sidebar counts are always computed against the full catalog so the
	// numbers stay stable while a user toggles filters — applying the active
	// filter to the counts would cause every count except the selected one to
	// drop to zero, which is not how the sidebar reads.
	const allPackages = await db
		.select({
			id: catalogPackages.id,
			useCase: catalogPackages.useCase,
		})
		.from(catalogPackages)

	const allPackageIds = allPackages.map((p) => p.id)
	const allItemTypes = await loadItemTypesByPackage(db, allPackageIds)

	const byType = { actor: 0, trigger: 0, skill: 0, integration: 0 }
	const byUseCase: Record<string, number> = {}
	for (const pkg of allPackages) {
		const types = allItemTypes.get(pkg.id) ?? []
		for (const t of types) byType[t] += 1
		const useCaseKey = pkg.useCase ?? 'uncategorized'
		byUseCase[useCaseKey] = (byUseCase[useCaseKey] ?? 0) + 1
	}

	const conditions = []
	if (use_case) conditions.push(eq(catalogPackages.useCase, use_case))
	if (q) {
		const pattern = `%${q}%`
		conditions.push(
			or(
				ilike(catalogPackages.name, pattern),
				ilike(catalogPackages.description, pattern),
				ilike(catalogPackages.slug, pattern),
			),
		)
	}
	if (type) {
		// A package matches `type=X` if at least one of its items has that
		// type. Express it as an IN subquery against catalog_package_items
		// keyed by package_id — short and indexed by the package_idx.
		conditions.push(
			sql`${catalogPackages.id} IN (
				SELECT ${catalogPackageItems.packageId}
				FROM ${catalogPackageItems}
				WHERE ${catalogPackageItems.itemType} = ${type}
			)`,
		)
	}

	const filteredRows = await db
		.select()
		.from(catalogPackages)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(asc(catalogPackages.name))

	const filteredIds = filteredRows.map((r) => r.id)
	const filteredItemTypes = await loadItemTypesByPackage(db, filteredIds)

	const packages = filteredRows.map((row) =>
		toPackageSummary(row, filteredItemTypes.get(row.id) ?? []),
	)

	logger.info('catalog packages listed', {
		filteredCount: packages.length,
		totalCount: allPackages.length,
		type,
		useCase: use_case,
		q,
	})

	const response: z.infer<typeof listPackagesResponseSchema> = {
		packages,
		counts: {
			total: allPackages.length,
			by_type: byType,
			by_use_case: byUseCase,
		},
	}
	return c.json(response)
}) as RouteHandler<typeof listPackagesRoute, Env>)

// ── GET /api/catalog/packages/:id ─────────────────────────────────────────────

const getPackageRoute = createRoute({
	method: 'get',
	path: '/packages/{id}',
	tags: ['Catalog'],
	summary: 'Get a catalog package with its frozen items',
	request: { params: idParamSchema },
	responses: {
		200: {
			description: 'Catalog package detail',
			content: { 'application/json': { schema: packageDetailResponseSchema } },
		},
		404: {
			description: 'Package not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(getPackageRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')

	const [row] = await db.select().from(catalogPackages).where(eq(catalogPackages.id, id)).limit(1)
	if (!row) {
		return c.json(createApiError('NOT_FOUND', 'Catalog package not found'), 404)
	}

	const itemRows = await db
		.select()
		.from(catalogPackageItems)
		.where(eq(catalogPackageItems.packageId, id))
		.orderBy(asc(catalogPackageItems.createdAt))

	const itemTypes: ItemType[] = []
	for (const item of itemRows) {
		if (isItemType(item.itemType) && !itemTypes.includes(item.itemType)) {
			itemTypes.push(item.itemType)
		}
	}
	itemTypes.sort()

	const response: z.infer<typeof packageDetailResponseSchema> = {
		package: toPackageSummary(row, itemTypes),
		items: itemRows.map(toPackageItem),
	}

	logger.info('catalog package detail fetched', {
		packageId: id,
		itemCount: response.items.length,
	})

	return c.json(response)
}) as RouteHandler<typeof getPackageRoute, Env>)

// ── GET /api/catalog/items/installed?workspaceId=X ───────────────────────────
//
// Returns all catalog items (installed via the individual-item endpoint) that
// are present in the given workspace. Actors are matched via workspace_members;
// other types are matched by workspace_id column. All rows must have a
// non-null catalog_item_id in their metadata to appear here.

const installedItemsQuerySchema = z.object({
	workspaceId: z.string().uuid(),
})

const installedItemEntrySchema = z.object({
	catalog_item_id: z.string().uuid(),
	entity_id: z.string().uuid(),
	entity_type: z.enum(['actor', 'trigger', 'skill', 'integration']),
})

const installedItemsResponseSchema = z.object({
	items: z.array(installedItemEntrySchema),
})

const listInstalledItemsRoute = createRoute({
	method: 'get',
	path: '/items/installed',
	tags: ['Catalog'],
	summary: 'List individually-installed catalog items for a workspace',
	request: { query: installedItemsQuerySchema },
	responses: {
		200: {
			description: 'Installed catalog items',
			content: { 'application/json': { schema: installedItemsResponseSchema } },
		},
		400: {
			description: 'Validation error',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not a member of the workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listInstalledItemsRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { workspaceId } = c.req.valid('query')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'You are not a member of the workspace'), 403)
	}

	const [actorRows, triggerRows, skillRows, integrationRows] = await Promise.all([
		db
			.select({
				catalogItemId: sql<string>`${actors.metadata}->>'catalog_item_id'`,
				entityId: actors.id,
			})
			.from(actors)
			.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspaceId),
					sql`${actors.metadata}->>'catalog_item_id' IS NOT NULL`,
				),
			),
		db
			.select({
				catalogItemId: sql<string>`${triggers.metadata}->>'catalog_item_id'`,
				entityId: triggers.id,
			})
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, workspaceId),
					sql`${triggers.metadata}->>'catalog_item_id' IS NOT NULL`,
				),
			),
		db
			.select({
				catalogItemId: sql<string>`${workspaceSkills.metadata}->>'catalog_item_id'`,
				entityId: workspaceSkills.id,
			})
			.from(workspaceSkills)
			.where(
				and(
					eq(workspaceSkills.workspaceId, workspaceId),
					sql`${workspaceSkills.metadata}->>'catalog_item_id' IS NOT NULL`,
				),
			),
		db
			.select({
				catalogItemId: sql<string>`${integrations.metadata}->>'catalog_item_id'`,
				entityId: integrations.id,
			})
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					sql`${integrations.metadata}->>'catalog_item_id' IS NOT NULL`,
				),
			),
	])

	const items = [
		...actorRows.map((r) => ({
			catalog_item_id: r.catalogItemId,
			entity_id: r.entityId,
			entity_type: 'actor' as const,
		})),
		...triggerRows.map((r) => ({
			catalog_item_id: r.catalogItemId,
			entity_id: r.entityId,
			entity_type: 'trigger' as const,
		})),
		...skillRows.map((r) => ({
			catalog_item_id: r.catalogItemId,
			entity_id: r.entityId,
			entity_type: 'skill' as const,
		})),
		...integrationRows.map((r) => ({
			catalog_item_id: r.catalogItemId,
			entity_id: r.entityId,
			entity_type: 'integration' as const,
		})),
	]

	return c.json({ items }, 200)
}) as RouteHandler<typeof listInstalledItemsRoute, Env>)

// ── DELETE /api/catalog/items/:id/uninstall ───────────────────────────────────
//
// Remove an individually-installed catalog item from a workspace.
// `keepProvisionedItems` mirrors the package-uninstall semantics:
//   false — cascade-delete the provisioned entity
//   true  — strip catalog metadata so the entity becomes a plain workspace resource

const uninstallItemBodySchema = z.object({
	workspaceId: z.string().uuid(),
	keepProvisionedItems: z.boolean(),
})

const uninstallItemResponseSchema = z.object({
	deleted: z.boolean(),
})

const uninstallItemRoute = createRoute({
	method: 'delete',
	path: '/items/{id}/uninstall',
	tags: ['Catalog'],
	summary: 'Remove an individually-installed catalog item from a workspace',
	request: {
		params: idParamSchema,
		body: { content: { 'application/json': { schema: uninstallItemBodySchema } } },
	},
	responses: {
		200: {
			description: 'Item removed',
			content: { 'application/json': { schema: uninstallItemResponseSchema } },
		},
		400: {
			description: 'Validation error',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not a member of the workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Catalog item not found or not installed',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(uninstallItemRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id: itemId } = c.req.valid('param')
	const { workspaceId, keepProvisionedItems } = c.req.valid('json')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'You are not a member of the workspace'), 403)
	}

	const [item] = await db
		.select()
		.from(catalogPackageItems)
		.where(eq(catalogPackageItems.id, itemId))
		.limit(1)

	if (!item) {
		return c.json(createApiError('NOT_FOUND', 'Catalog item not found'), 404)
	}

	const type = item.itemType as CatalogItemType

	// Find the local entity that was provisioned from this catalog item.
	type LocalEntity = { entityId: string }
	let localEntity: LocalEntity | undefined

	switch (type) {
		case 'actor': {
			const [row] = await db
				.select({ entityId: actors.id })
				.from(actors)
				.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
				.where(
					and(
						eq(workspaceMembers.workspaceId, workspaceId),
						sql`${actors.metadata}->>'catalog_item_id' = ${itemId}`,
					),
				)
				.limit(1)
			if (row) localEntity = row
			break
		}
		case 'trigger': {
			const [row] = await db
				.select({ entityId: triggers.id })
				.from(triggers)
				.where(
					and(
						eq(triggers.workspaceId, workspaceId),
						sql`${triggers.metadata}->>'catalog_item_id' = ${itemId}`,
					),
				)
				.limit(1)
			if (row) localEntity = row
			break
		}
		case 'skill': {
			const [row] = await db
				.select({ entityId: workspaceSkills.id })
				.from(workspaceSkills)
				.where(
					and(
						eq(workspaceSkills.workspaceId, workspaceId),
						sql`${workspaceSkills.metadata}->>'catalog_item_id' = ${itemId}`,
					),
				)
				.limit(1)
			if (row) localEntity = row
			break
		}
		case 'integration': {
			const [row] = await db
				.select({ entityId: integrations.id })
				.from(integrations)
				.where(
					and(
						eq(integrations.workspaceId, workspaceId),
						sql`${integrations.metadata}->>'catalog_item_id' = ${itemId}`,
					),
				)
				.limit(1)
			if (row) localEntity = row
			break
		}
	}

	if (!localEntity) {
		return c.json(
			createApiError('NOT_FOUND', 'This catalog item is not installed in the workspace'),
			404,
		)
	}

	const { entityId } = localEntity

	await db.transaction(async (tx) => {
		if (keepProvisionedItems) {
			// Strip catalog tracking keys so the entity becomes a plain workspace resource.
			const catalogKeysClause = sql`${actors.metadata} - 'catalog_item_id' - 'source_item_id' - 'snapshot'`
			switch (type) {
				case 'actor':
					await tx
						.update(actors)
						.set({ metadata: catalogKeysClause })
						.where(eq(actors.id, entityId))
					break
				case 'trigger':
					await tx
						.update(triggers)
						.set({
							metadata: sql`${triggers.metadata} - 'catalog_item_id' - 'source_item_id' - 'snapshot'`,
						})
						.where(eq(triggers.id, entityId))
					break
				case 'skill':
					await tx
						.update(workspaceSkills)
						.set({
							metadata: sql`${workspaceSkills.metadata} - 'catalog_item_id' - 'source_item_id' - 'snapshot'`,
						})
						.where(eq(workspaceSkills.id, entityId))
					break
				case 'integration':
					await tx
						.update(integrations)
						.set({
							metadata: sql`${integrations.metadata} - 'catalog_item_id' - 'source_item_id' - 'snapshot'`,
						})
						.where(eq(integrations.id, entityId))
					break
			}
		} else {
			// Hard-delete the entity. Actors require a full cascade; others are a single row delete.
			switch (type) {
				case 'actor': {
					const actorSessions = await tx
						.select({ id: sessions.id })
						.from(sessions)
						.where(eq(sessions.actorId, entityId))
					const sessionIds = actorSessions.map((s) => s.id)
					if (sessionIds.length > 0) {
						await tx.delete(sessionLogs).where(inArray(sessionLogs.sessionId, sessionIds))
					}
					await tx.delete(sessions).where(eq(sessions.actorId, entityId))
					await tx
						.update(sessions)
						.set({ createdBy: actorId })
						.where(eq(sessions.createdBy, entityId))
					await tx
						.delete(triggers)
						.where(or(eq(triggers.targetActorId, entityId), eq(triggers.createdBy, entityId)))
					await tx.delete(agentFiles).where(eq(agentFiles.actorId, entityId))
					await tx
						.delete(notifications)
						.where(
							or(
								eq(notifications.sourceActorId, entityId),
								eq(notifications.targetActorId, entityId),
							),
						)
					await tx.delete(events).where(eq(events.actorId, entityId))
					await tx.delete(relationships).where(eq(relationships.createdBy, entityId))
					await tx.delete(subscriptions).where(eq(subscriptions.actorId, entityId))
					await tx.delete(readState).where(eq(readState.actorId, entityId))
					await tx.update(objects).set({ driver: null }).where(eq(objects.driver, entityId))
					await tx
						.update(objects)
						.set({ createdBy: actorId })
						.where(eq(objects.createdBy, entityId))
					await tx.update(files).set({ createdBy: actorId }).where(eq(files.createdBy, entityId))
					await tx
						.update(imports)
						.set({ createdBy: actorId })
						.where(eq(imports.createdBy, entityId))
					await tx
						.update(workspaceSkills)
						.set({ createdBy: null })
						.where(eq(workspaceSkills.createdBy, entityId))
					await tx
						.update(workspaces)
						.set({ createdBy: null })
						.where(eq(workspaces.createdBy, entityId))
					await tx
						.update(integrations)
						.set({ createdBy: actorId })
						.where(eq(integrations.createdBy, entityId))
					await tx.update(actors).set({ createdBy: null }).where(eq(actors.createdBy, entityId))
					await tx.delete(workspaceMembers).where(eq(workspaceMembers.actorId, entityId))
					await tx.delete(actors).where(eq(actors.id, entityId))
					break
				}
				case 'trigger':
					await tx.delete(triggers).where(eq(triggers.id, entityId))
					break
				case 'skill':
					await tx.delete(workspaceSkills).where(eq(workspaceSkills.id, entityId))
					break
				case 'integration':
					await tx.delete(integrations).where(eq(integrations.id, entityId))
					break
			}
		}

		await tx.insert(events).values({
			workspaceId,
			actorId,
			action: 'deleted',
			entityType: type === 'actor' ? 'actor' : type === 'trigger' ? 'trigger' : type,
			entityId,
			data: {
				source: 'catalog_item',
				catalog_item_id: itemId,
				kept_items: keepProvisionedItems,
			},
		})
	})

	logger.info('Catalog item uninstalled', {
		itemId,
		workspaceId,
		type,
		entityId,
		keepProvisionedItems,
	})
	return c.json({ deleted: true }, 200)
}) as RouteHandler<typeof uninstallItemRoute, Env>)

// ── POST /api/catalog/items/:id/install ──────────────────────────────────────
//
// Install a single catalog item into a workspace. This is the individual-item
// counterpart to POST /api/installed-packages (which installs every item in a
// package). Actors get a fresh apiKey and a workspace_members row; triggers
// resolve their target actor via source_item_id in the workspace's actor pool.
// No installed_packages row is created — the item becomes a plain workspace
// resource tracked only by catalog_item_id in its metadata.

const installItemBodySchema = z.object({
	workspaceId: z.string().uuid(),
})

const installItemResponseSchema = z.object({
	id: z.string().uuid(),
	item_type: itemTypeSchema,
	name: z.string(),
})

const installItemRoute = createRoute({
	method: 'post',
	path: '/items/{id}/install',
	tags: ['Catalog'],
	summary: 'Install a single catalog item into a workspace',
	request: {
		params: idParamSchema,
		body: { content: { 'application/json': { schema: installItemBodySchema } } },
	},
	responses: {
		201: {
			description: 'Item installed',
			content: { 'application/json': { schema: installItemResponseSchema } },
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
			description: 'Catalog item not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Item already installed in this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		422: {
			description: 'Trigger target agent not found — install the agent first',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(installItemRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id: itemId } = c.req.valid('param')
	const { workspaceId } = c.req.valid('json')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'You are not a member of the target workspace'), 403)
	}

	const [item] = await db
		.select()
		.from(catalogPackageItems)
		.where(eq(catalogPackageItems.id, itemId))
		.limit(1)

	if (!item) {
		return c.json(createApiError('NOT_FOUND', 'Catalog item not found'), 404)
	}

	const type = item.itemType as CatalogItemType
	const snapshot = (item.itemSnapshot as Record<string, unknown>) ?? {}
	// Individual-item installs are tracked by catalog_item_id in metadata.
	// No installed_package_id is set so the version-push cron ignores them.
	const meta = { catalog_item_id: item.id, source_item_id: item.sourceItemId, snapshot }

	const name = (snapshot.name as string) ?? 'Untitled'

	switch (type) {
		case 'actor': {
			const [existing] = await db
				.select({ id: actors.id })
				.from(actors)
				.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
				.where(
					and(
						eq(workspaceMembers.workspaceId, workspaceId),
						sql`${actors.metadata}->>'catalog_item_id' = ${item.id}`,
					),
				)
				.limit(1)
			if (existing) {
				return c.json(
					createApiError('CONFLICT', 'This agent is already installed in the workspace'),
					409,
				)
			}
			const [row] = await db.transaction(async (tx) => {
				const [a] = await tx
					.insert(actors)
					.values(buildActorInsert(snapshot, meta, actorId))
					.returning({ id: actors.id, name: actors.name })
				if (!a) throw new Error('Actor insert returned no row')
				await tx.insert(workspaceMembers).values({ workspaceId, actorId: a.id, role: 'member' })
				await tx.insert(events).values({
					workspaceId,
					actorId,
					action: 'created',
					entityType: 'actor',
					entityId: a.id,
					data: { source: 'catalog_item', catalog_item_id: item.id },
				})
				return [a] as const
			})
			logger.info('Catalog item installed (actor)', { itemId, workspaceId, actorId: row.id })
			return c.json({ id: row.id, item_type: type, name: row.name ?? name }, 201)
		}

		case 'trigger': {
			const [existing] = await db
				.select({ id: triggers.id })
				.from(triggers)
				.where(
					and(
						eq(triggers.workspaceId, workspaceId),
						sql`${triggers.metadata}->>'catalog_item_id' = ${item.id}`,
					),
				)
				.limit(1)
			if (existing) {
				return c.json(
					createApiError('CONFLICT', 'This trigger is already installed in the workspace'),
					409,
				)
			}
			// The trigger snapshot's targetActorId is the source actor ID from the
			// publishing workspace. Find the corresponding installed actor in this
			// workspace by matching source_item_id in actor metadata.
			const targetSourceId =
				(snapshot.targetActorId as string) ?? (snapshot.target_actor_id as string)
			const [localActor] = await db
				.select({ id: actors.id })
				.from(actors)
				.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
				.where(
					and(
						eq(workspaceMembers.workspaceId, workspaceId),
						sql`${actors.metadata}->>'source_item_id' = ${targetSourceId}`,
					),
				)
				.limit(1)
			if (!localActor) {
				return c.json(
					createApiError(
						'BAD_REQUEST',
						'Target agent not found in workspace — install the agent first',
					),
					422,
				)
			}
			const rewrittenSnapshot = { ...snapshot, targetActorId: localActor.id }
			const triggerMeta = { ...meta, snapshot: rewrittenSnapshot }
			const [row] = await db.transaction(async (tx) => {
				const [t] = await tx
					.insert(triggers)
					.values(buildTriggerInsert(workspaceId, rewrittenSnapshot, triggerMeta, actorId))
					.returning({ id: triggers.id, name: triggers.name })
				if (!t) throw new Error('Trigger insert returned no row')
				await tx.insert(events).values({
					workspaceId,
					actorId,
					action: 'created',
					entityType: 'trigger',
					entityId: t.id,
					data: { source: 'catalog_item', catalog_item_id: item.id },
				})
				return [t] as const
			})
			logger.info('Catalog item installed (trigger)', { itemId, workspaceId, triggerId: row.id })
			return c.json({ id: row.id, item_type: type, name: row.name ?? name }, 201)
		}

		case 'skill': {
			const [existing] = await db
				.select({ id: workspaceSkills.id })
				.from(workspaceSkills)
				.where(
					and(
						eq(workspaceSkills.workspaceId, workspaceId),
						sql`${workspaceSkills.metadata}->>'catalog_item_id' = ${item.id}`,
					),
				)
				.limit(1)
			if (existing) {
				return c.json(
					createApiError('CONFLICT', 'This skill is already installed in the workspace'),
					409,
				)
			}
			const [row] = await db.transaction(async (tx) => {
				const [s] = await tx
					.insert(workspaceSkills)
					.values(buildSkillInsert(workspaceId, snapshot, meta, actorId))
					.returning({ id: workspaceSkills.id, name: workspaceSkills.name })
				if (!s) throw new Error('Skill insert returned no row')
				await tx.insert(events).values({
					workspaceId,
					actorId,
					action: 'created',
					entityType: 'workspace_skill',
					entityId: s.id,
					data: { source: 'catalog_item', catalog_item_id: item.id },
				})
				return [s] as const
			})
			logger.info('Catalog item installed (skill)', { itemId, workspaceId, skillId: row.id })
			return c.json({ id: row.id, item_type: type, name: row.name ?? name }, 201)
		}

		case 'integration': {
			const [existing] = await db
				.select({ id: integrations.id })
				.from(integrations)
				.where(
					and(
						eq(integrations.workspaceId, workspaceId),
						sql`${integrations.metadata}->>'catalog_item_id' = ${item.id}`,
					),
				)
				.limit(1)
			if (existing) {
				return c.json(
					createApiError('CONFLICT', 'This integration is already installed in the workspace'),
					409,
				)
			}
			const [row] = await db.transaction(async (tx) => {
				const [i] = await tx
					.insert(integrations)
					.values(buildIntegrationInsert(workspaceId, snapshot, meta, actorId))
					.returning({ id: integrations.id })
				if (!i) throw new Error('Integration insert returned no row')
				await tx.insert(events).values({
					workspaceId,
					actorId,
					action: 'created',
					entityType: 'integration',
					entityId: i.id,
					data: { source: 'catalog_item', catalog_item_id: item.id },
				})
				return [i] as const
			})
			logger.info('Catalog item installed (integration)', {
				itemId,
				workspaceId,
				integrationId: row.id,
			})
			return c.json(
				{
					id: row.id,
					item_type: type,
					name: (snapshot.provider as string) ?? name,
				},
				201,
			)
		}

		default:
			return c.json(createApiError('BAD_REQUEST', `Unsupported item type: ${type}`), 400)
	}
}) as RouteHandler<typeof installItemRoute, Env>)

export default app
