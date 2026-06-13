import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	type CatalogPackage,
	type CatalogPackageItem,
	catalogPackageItems,
	catalogPackages,
} from '@maskin/db/schema'
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, jsonbField } from '../lib/openapi-schemas'

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

export default app
