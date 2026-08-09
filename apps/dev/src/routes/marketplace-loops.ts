import { randomUUID } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	type MarketplaceLoop,
	type MarketplaceLoopItem,
	actors,
	agentFiles,
	files,
	imports,
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
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, jsonbField } from '../lib/openapi-schemas'
import { isWorkspaceMember } from '../lib/workspace-auth'
import { type AgentStorageManager, workspaceSkillKey } from '../services/agent-storage'
import {
	type MarketplaceItemType,
	buildIntegrationInsert,
	buildSkillInsert,
	buildTriggerInsert,
	claimProvisionedActor,
	findProvisionedActorByMetadataKey,
} from '../services/loop-provisioning'

type Env = {
	Variables: {
		db: Database
		actorId: string
		agentStorage: AgentStorageManager
	}
}

const app = new OpenAPIHono<Env>()

// The marketplace itself is global — loops aren't scoped to any workspace.
// Routes are mounted behind the API-key auth middleware in app-factory; no
// per-workspace membership check is needed (and an X-Workspace-Id header is
// not required because the marketplace reads identically for every caller).

// Thrown to unwind an individual-item install transaction into a 409 when the
// claim-first actor insert (see claimProvisionedActor) reports the workspace
// already holds the agent. Rolling the claim back into an error keeps the
// membership + event writes and the actor insert in one atomic transaction.
class ActorAlreadyInstalledError extends Error {
	constructor() {
		super('actor already installed in workspace')
		this.name = 'ActorAlreadyInstalledError'
	}
}

const ITEM_TYPES = ['actor', 'trigger', 'skill', 'integration'] as const
type ItemType = (typeof ITEM_TYPES)[number]

// ── Response schemas ──────────────────────────────────────────────────────────
//
// Named `marketplaceLoop*` (not the bare `loop*` used by
// `packages/shared/src/schemas/loops.ts`) to avoid confusion with the
// loops-first-class bet's `GET /api/loops` read shape — these describe the
// installable *template*, not a running `objects.type = 'loop'` instance.

const itemTypeSchema = z.enum(ITEM_TYPES)

const marketplaceLoopSummarySchema = z.object({
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

const listMarketplaceLoopsResponseSchema = z.object({
	loops: z.array(marketplaceLoopSummarySchema),
	counts: countsSchema,
})

const marketplaceLoopItemSchema = z.object({
	id: z.string().uuid(),
	loop_id: z.string().uuid(),
	item_type: itemTypeSchema,
	source_item_id: z.string().uuid(),
	item_snapshot: jsonbField,
	created_at: z.string().nullable(),
})

const marketplaceLoopDetailResponseSchema = z.object({
	loop: marketplaceLoopSummarySchema,
	items: z.array(marketplaceLoopItemSchema),
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function isItemType(value: string): value is ItemType {
	return (ITEM_TYPES as readonly string[]).includes(value)
}

function isoOrNull(value: Date | null | undefined): string | null {
	return value instanceof Date ? value.toISOString() : (value ?? null)
}

function toMarketplaceLoopSummary(
	row: MarketplaceLoop,
	itemTypes: ItemType[],
): z.infer<typeof marketplaceLoopSummarySchema> {
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

function toMarketplaceLoopItem(
	row: MarketplaceLoopItem,
): z.infer<typeof marketplaceLoopItemSchema> {
	return {
		id: row.id,
		loop_id: row.loopId,
		item_type: row.itemType as ItemType,
		source_item_id: row.sourceItemId,
		item_snapshot: row.itemSnapshot as z.infer<typeof jsonbField>,
		created_at: isoOrNull(row.createdAt),
	}
}

async function loadItemTypesByLoop(
	db: Database,
	loopIds: string[],
): Promise<Map<string, ItemType[]>> {
	if (loopIds.length === 0) return new Map()
	const rows = await db
		.selectDistinct({
			loopId: marketplaceLoopItems.loopId,
			itemType: marketplaceLoopItems.itemType,
		})
		.from(marketplaceLoopItems)
		.where(inArray(marketplaceLoopItems.loopId, loopIds))

	const byLoop = new Map<string, ItemType[]>()
	for (const row of rows) {
		if (!isItemType(row.itemType)) continue
		const existing = byLoop.get(row.loopId) ?? []
		existing.push(row.itemType)
		byLoop.set(row.loopId, existing)
	}
	for (const list of byLoop.values()) list.sort()
	return byLoop
}

// ── GET /api/marketplace/loops ────────────────────────────────────────────────

const listQuerySchema = z.object({
	type: itemTypeSchema.optional(),
	use_case: z.string().min(1).max(200).optional(),
	q: z.string().min(1).max(200).optional(),
})

const listMarketplaceLoopsRoute = createRoute({
	method: 'get',
	path: '/loops',
	tags: ['Marketplace'],
	summary: 'List marketplace loops with sidebar counts',
	request: {
		query: listQuerySchema,
	},
	responses: {
		200: {
			description: 'Loops matching the filters plus full-marketplace counts for the sidebar.',
			content: { 'application/json': { schema: listMarketplaceLoopsResponseSchema } },
		},
		400: {
			description: 'Invalid query parameter',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listMarketplaceLoopsRoute, (async (c) => {
	const db = c.get('db')
	const { type, use_case, q } = c.req.valid('query')

	// Sidebar counts are always computed against the full marketplace so the
	// numbers stay stable while a user toggles filters — applying the active
	// filter to the counts would cause every count except the selected one to
	// drop to zero, which is not how the sidebar reads.
	const allLoops = await db
		.select({
			id: marketplaceLoops.id,
			useCase: marketplaceLoops.useCase,
		})
		.from(marketplaceLoops)

	const allLoopIds = allLoops.map((l) => l.id)
	const allItemTypes = await loadItemTypesByLoop(db, allLoopIds)

	const byType = { actor: 0, trigger: 0, skill: 0, integration: 0 }
	const byUseCase: Record<string, number> = {}
	for (const loop of allLoops) {
		const types = allItemTypes.get(loop.id) ?? []
		for (const t of types) byType[t] += 1
		const useCaseKey = loop.useCase ?? 'uncategorized'
		byUseCase[useCaseKey] = (byUseCase[useCaseKey] ?? 0) + 1
	}

	const conditions = []
	if (use_case) conditions.push(eq(marketplaceLoops.useCase, use_case))
	if (q) {
		const pattern = `%${q}%`
		conditions.push(
			or(
				ilike(marketplaceLoops.name, pattern),
				ilike(marketplaceLoops.description, pattern),
				ilike(marketplaceLoops.slug, pattern),
			),
		)
	}
	if (type) {
		// A loop matches `type=X` if at least one of its items has that
		// type. Express it as an IN subquery against marketplace_loop_items
		// keyed by loop_id — short and indexed by the loop_idx.
		conditions.push(
			sql`${marketplaceLoops.id} IN (
				SELECT ${marketplaceLoopItems.loopId}
				FROM ${marketplaceLoopItems}
				WHERE ${marketplaceLoopItems.itemType} = ${type}
			)`,
		)
	}

	const filteredRows = await db
		.select()
		.from(marketplaceLoops)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(asc(marketplaceLoops.name))

	const filteredIds = filteredRows.map((r) => r.id)
	const filteredItemTypes = await loadItemTypesByLoop(db, filteredIds)

	const loops = filteredRows.map((row) =>
		toMarketplaceLoopSummary(row, filteredItemTypes.get(row.id) ?? []),
	)

	logger.info('marketplace loops listed', {
		filteredCount: loops.length,
		totalCount: allLoops.length,
		type,
		useCase: use_case,
		q,
	})

	const response: z.infer<typeof listMarketplaceLoopsResponseSchema> = {
		loops,
		counts: {
			total: allLoops.length,
			by_type: byType,
			by_use_case: byUseCase,
		},
	}
	return c.json(response)
}) as RouteHandler<typeof listMarketplaceLoopsRoute, Env>)

// ── GET /api/marketplace/loops/:id ────────────────────────────────────────────

const getMarketplaceLoopRoute = createRoute({
	method: 'get',
	path: '/loops/{id}',
	tags: ['Marketplace'],
	summary: 'Get a marketplace loop with its frozen items',
	request: { params: idParamSchema },
	responses: {
		200: {
			description: 'Marketplace loop detail',
			content: { 'application/json': { schema: marketplaceLoopDetailResponseSchema } },
		},
		404: {
			description: 'Loop not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(getMarketplaceLoopRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')

	const [row] = await db.select().from(marketplaceLoops).where(eq(marketplaceLoops.id, id)).limit(1)
	if (!row) {
		return c.json(createApiError('NOT_FOUND', 'Marketplace loop not found'), 404)
	}

	const itemRows = await db
		.select()
		.from(marketplaceLoopItems)
		.where(eq(marketplaceLoopItems.loopId, id))
		.orderBy(asc(marketplaceLoopItems.createdAt))

	const itemTypes: ItemType[] = []
	for (const item of itemRows) {
		if (isItemType(item.itemType) && !itemTypes.includes(item.itemType)) {
			itemTypes.push(item.itemType)
		}
	}
	itemTypes.sort()

	const response: z.infer<typeof marketplaceLoopDetailResponseSchema> = {
		loop: toMarketplaceLoopSummary(row, itemTypes),
		items: itemRows.map(toMarketplaceLoopItem),
	}

	logger.info('marketplace loop detail fetched', {
		loopId: id,
		itemCount: response.items.length,
	})

	return c.json(response)
}) as RouteHandler<typeof getMarketplaceLoopRoute, Env>)

// ── GET /api/marketplace/items/installed?workspaceId=X ───────────────────────
//
// Returns all marketplace items (installed via the individual-item endpoint)
// that are present in the given workspace. Actors are matched via
// workspace_members; other types are matched by workspace_id column. All rows
// must have a non-null marketplace_item_id in their metadata to appear here.

const installedItemsQuerySchema = z.object({
	workspaceId: z.string().uuid(),
})

const installedItemEntrySchema = z.object({
	marketplace_item_id: z.string().uuid(),
	entity_id: z.string().uuid(),
	entity_type: z.enum(['actor', 'trigger', 'skill', 'integration']),
})

const installedItemsResponseSchema = z.object({
	items: z.array(installedItemEntrySchema),
})

const listInstalledItemsRoute = createRoute({
	method: 'get',
	path: '/items/installed',
	tags: ['Marketplace'],
	summary: 'List individually-installed marketplace items for a workspace',
	request: { query: installedItemsQuerySchema },
	responses: {
		200: {
			description: 'Installed marketplace items',
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
				marketplaceItemId: sql<string>`${actors.metadata}->>'marketplace_item_id'`,
				entityId: actors.id,
			})
			.from(actors)
			.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspaceId),
					sql`${actors.metadata}->>'marketplace_item_id' IS NOT NULL`,
				),
			),
		db
			.select({
				marketplaceItemId: sql<string>`${triggers.metadata}->>'marketplace_item_id'`,
				entityId: triggers.id,
			})
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, workspaceId),
					sql`${triggers.metadata}->>'marketplace_item_id' IS NOT NULL`,
				),
			),
		db
			.select({
				marketplaceItemId: sql<string>`${workspaceSkills.metadata}->>'marketplace_item_id'`,
				entityId: workspaceSkills.id,
			})
			.from(workspaceSkills)
			.where(
				and(
					eq(workspaceSkills.workspaceId, workspaceId),
					sql`${workspaceSkills.metadata}->>'marketplace_item_id' IS NOT NULL`,
				),
			),
		db
			.select({
				marketplaceItemId: sql<string>`${integrations.metadata}->>'marketplace_item_id'`,
				entityId: integrations.id,
			})
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					sql`${integrations.metadata}->>'marketplace_item_id' IS NOT NULL`,
				),
			),
	])

	const items = [
		...actorRows.map((r) => ({
			marketplace_item_id: r.marketplaceItemId,
			entity_id: r.entityId,
			entity_type: 'actor' as const,
		})),
		...triggerRows.map((r) => ({
			marketplace_item_id: r.marketplaceItemId,
			entity_id: r.entityId,
			entity_type: 'trigger' as const,
		})),
		...skillRows.map((r) => ({
			marketplace_item_id: r.marketplaceItemId,
			entity_id: r.entityId,
			entity_type: 'skill' as const,
		})),
		...integrationRows.map((r) => ({
			marketplace_item_id: r.marketplaceItemId,
			entity_id: r.entityId,
			entity_type: 'integration' as const,
		})),
	]

	return c.json({ items }, 200)
}) as RouteHandler<typeof listInstalledItemsRoute, Env>)

// ── DELETE /api/marketplace/items/:id/uninstall ───────────────────────────────
//
// Remove an individually-installed marketplace item from a workspace.
// `keepProvisionedItems` mirrors the loop-uninstall semantics:
//   false — cascade-delete the provisioned entity
//   true  — strip marketplace metadata so the entity becomes a plain workspace resource

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
	tags: ['Marketplace'],
	summary: 'Remove an individually-installed marketplace item from a workspace',
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
			description: 'Marketplace item not found or not installed',
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
		.from(marketplaceLoopItems)
		.where(eq(marketplaceLoopItems.id, itemId))
		.limit(1)

	if (!item) {
		return c.json(createApiError('NOT_FOUND', 'Marketplace item not found'), 404)
	}

	const type = item.itemType as MarketplaceItemType

	// Find the local entity that was provisioned from this marketplace item.
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
						sql`${actors.metadata}->>'marketplace_item_id' = ${itemId}`,
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
						sql`${triggers.metadata}->>'marketplace_item_id' = ${itemId}`,
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
						sql`${workspaceSkills.metadata}->>'marketplace_item_id' = ${itemId}`,
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
						sql`${integrations.metadata}->>'marketplace_item_id' = ${itemId}`,
					),
				)
				.limit(1)
			if (row) localEntity = row
			break
		}
	}

	if (!localEntity) {
		return c.json(
			createApiError('NOT_FOUND', 'This marketplace item is not installed in the workspace'),
			404,
		)
	}

	const { entityId } = localEntity
	const agentStorage = c.get('agentStorage')
	// Set only on the skill hard-delete branch below; cleaned up from S3 after
	// the tx commits (see the post-commit block), mirroring installed-loops.ts.
	let removedSkillId: string | null = null

	await db.transaction(async (tx) => {
		if (keepProvisionedItems) {
			// Strip marketplace tracking keys so the entity becomes a plain workspace resource.
			const marketplaceKeysClause = sql`${actors.metadata} - 'marketplace_item_id' - 'source_item_id' - 'snapshot'`
			switch (type) {
				case 'actor':
					await tx
						.update(actors)
						.set({ metadata: marketplaceKeysClause })
						.where(eq(actors.id, entityId))
					break
				case 'trigger':
					await tx
						.update(triggers)
						.set({
							metadata: sql`${triggers.metadata} - 'marketplace_item_id' - 'source_item_id' - 'snapshot'`,
						})
						.where(eq(triggers.id, entityId))
					break
				case 'skill':
					await tx
						.update(workspaceSkills)
						.set({
							metadata: sql`${workspaceSkills.metadata} - 'marketplace_item_id' - 'source_item_id' - 'snapshot'`,
						})
						.where(eq(workspaceSkills.id, entityId))
					break
				case 'integration':
					await tx
						.update(integrations)
						.set({
							metadata: sql`${integrations.metadata} - 'marketplace_item_id' - 'source_item_id' - 'snapshot'`,
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
					removedSkillId = entityId
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
				source: 'marketplace_item',
				marketplace_item_id: itemId,
				kept_items: keepProvisionedItems,
			},
		})
	})

	if (removedSkillId) {
		try {
			await agentStorage.deleteWorkspaceSkill(workspaceId, removedSkillId)
		} catch (err) {
			logger.error('Failed to delete workspace skill from storage (orphan object left)', {
				workspaceId,
				skillId: removedSkillId,
				error: String(err),
			})
		}
	}

	logger.info('Marketplace item uninstalled', {
		itemId,
		workspaceId,
		type,
		entityId,
		keepProvisionedItems,
	})
	return c.json({ deleted: true }, 200)
}) as RouteHandler<typeof uninstallItemRoute, Env>)

// ── POST /api/marketplace/items/:id/install ───────────────────────────────────
//
// Install a single marketplace item into a workspace. This is the
// individual-item counterpart to POST /api/installed-loops (which installs
// every item in a loop). Actors get a fresh apiKey and a workspace_members
// row; triggers resolve their target actor via source_item_id in the
// workspace's actor pool. No installed_loops row is created — the item
// becomes a plain workspace resource tracked only by marketplace_item_id in
// its metadata.

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
	tags: ['Marketplace'],
	summary: 'Install a single marketplace item into a workspace',
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
			description: 'Marketplace item not found',
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
		.from(marketplaceLoopItems)
		.where(eq(marketplaceLoopItems.id, itemId))
		.limit(1)

	if (!item) {
		return c.json(createApiError('NOT_FOUND', 'Marketplace item not found'), 404)
	}

	const type = item.itemType as MarketplaceItemType
	const snapshot = (item.itemSnapshot as Record<string, unknown>) ?? {}
	// Individual-item installs are tracked by marketplace_item_id in metadata.
	// No installed_loop_id is set so the version-push cron ignores them.
	const meta = { marketplace_item_id: item.id, source_item_id: item.sourceItemId, snapshot }

	const name = (snapshot.name as string) ?? 'Untitled'

	switch (type) {
		case 'actor': {
			// Claim-first dedup, same backstop as loop installs (the partial unique
			// index on (workspace_id, metadata->>'source_item_id')): the INSERT is the
			// claim and a lost claim means the workspace already holds this agent —
			// whether from a prior individual-item install or a loop that bundles it —
			// so 409 instead of cloning. The old SELECT-then-INSERT could clone under
			// concurrency, when two parallel installs both passed the pre-check.
			try {
				const claim = await db.transaction(async (tx) => {
					const claim = await claimProvisionedActor(
						tx,
						workspaceId,
						item.sourceItemId,
						snapshot,
						meta,
						actorId,
					)
					if (!claim.created) throw new ActorAlreadyInstalledError()
					await tx
						.insert(workspaceMembers)
						.values({ workspaceId, actorId: claim.id, role: 'member' })
					await tx.insert(events).values({
						workspaceId,
						actorId,
						action: 'created',
						entityType: 'actor',
						entityId: claim.id,
						data: { source: 'marketplace_item', marketplace_item_id: item.id },
					})
					return claim
				})
				logger.info('Marketplace item installed (actor)', {
					itemId,
					workspaceId,
					actorId: claim.id,
				})
				return c.json({ id: claim.id, item_type: type, name }, 201)
			} catch (err) {
				if (err instanceof ActorAlreadyInstalledError) {
					return c.json(
						createApiError('CONFLICT', 'This agent is already installed in the workspace'),
						409,
					)
				}
				throw err
			}
		}

		case 'trigger': {
			const [existing] = await db
				.select({ id: triggers.id })
				.from(triggers)
				.where(
					and(
						eq(triggers.workspaceId, workspaceId),
						sql`${triggers.metadata}->>'marketplace_item_id' = ${item.id}`,
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
			// workspace by matching source_item_id in actor metadata — the same
			// parameterized lookup the loop-install dedup path uses.
			const targetSourceId =
				(snapshot.targetActorId as string) ?? (snapshot.target_actor_id as string)
			const localActor = await findProvisionedActorByMetadataKey(
				db,
				workspaceId,
				'source_item_id',
				targetSourceId,
			)
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
					data: { source: 'marketplace_item', marketplace_item_id: item.id },
				})
				return [t] as const
			})
			logger.info('Marketplace item installed (trigger)', {
				itemId,
				workspaceId,
				triggerId: row.id,
			})
			return c.json({ id: row.id, item_type: type, name: row.name ?? name }, 201)
		}

		case 'skill': {
			const [existing] = await db
				.select({ id: workspaceSkills.id })
				.from(workspaceSkills)
				.where(
					and(
						eq(workspaceSkills.workspaceId, workspaceId),
						sql`${workspaceSkills.metadata}->>'marketplace_item_id' = ${item.id}`,
					),
				)
				.limit(1)
			if (existing) {
				return c.json(
					createApiError('CONFLICT', 'This skill is already installed in the workspace'),
					409,
				)
			}
			const agentStorage = c.get('agentStorage')
			// Fresh id + workspace-scoped S3 key — never reuse the publisher's
			// storageKey (see buildSkillInsert). The S3 put happens inside the
			// tx, right after the insert, mirroring workspace-skills.ts's POST.
			const skillId = randomUUID()
			const storageKey = workspaceSkillKey(workspaceId, skillId)
			const [row] = await db.transaction(async (tx) => {
				const [s] = await tx
					.insert(workspaceSkills)
					.values(buildSkillInsert(workspaceId, skillId, storageKey, snapshot, meta, actorId))
					.returning({ id: workspaceSkills.id, name: workspaceSkills.name })
				if (!s) throw new Error('Skill insert returned no row')
				await agentStorage.putWorkspaceSkill(
					workspaceId,
					skillId,
					(snapshot.content as string) ?? '',
				)
				await tx.insert(events).values({
					workspaceId,
					actorId,
					action: 'created',
					entityType: 'workspace_skill',
					entityId: s.id,
					data: { source: 'marketplace_item', marketplace_item_id: item.id },
				})
				return [s] as const
			})
			logger.info('Marketplace item installed (skill)', { itemId, workspaceId, skillId: row.id })
			return c.json({ id: row.id, item_type: type, name: row.name ?? name }, 201)
		}

		case 'integration': {
			const [existing] = await db
				.select({ id: integrations.id })
				.from(integrations)
				.where(
					and(
						eq(integrations.workspaceId, workspaceId),
						sql`${integrations.metadata}->>'marketplace_item_id' = ${item.id}`,
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
					data: { source: 'marketplace_item', marketplace_item_id: item.id },
				})
				return [i] as const
			})
			logger.info('Marketplace item installed (integration)', {
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
