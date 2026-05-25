import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, relationships, workspaces } from '@maskin/db/schema'
import { getAllValidTypes, getEnabledModuleIds } from '@maskin/module-sdk'
import { createGraphSchema } from '@maskin/shared'
import { eq, inArray } from 'drizzle-orm'
import { createApiError, createInvalidTypeError } from '../lib/errors'
import { logger } from '../lib/logger'
import {
	errorSchema,
	objectResponseSchema,
	relationshipResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import type { WorkspaceSettings } from '../lib/types'
import { autoSubscribe } from '../services/subscriptions'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

const graphResponseSchema = z.object({
	nodes: z.array(objectResponseSchema.extend({ $id: z.string() })),
	edges: z.array(relationshipResponseSchema),
})

const createGraphRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Graph'],
	summary: 'Create objects and relationships in a single atomic operation',
	description:
		'Accepts a graph of nodes (objects) and edges (relationships) with client-side temporary IDs ($id) for cross-referencing. All operations run in a single database transaction.',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: createGraphSchema,
				},
			},
		},
	},
	responses: {
		201: {
			content: { 'application/json': { schema: graphResponseSchema } },
			description: 'Graph created',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Workspace not found',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Internal server error',
		},
	},
})

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

app.openapi(createGraphRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	// Validate workspace exists
	const [workspace] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	// Validate unique $ids
	const ids = body.nodes.map((n) => n.$id)
	if (new Set(ids).size !== ids.length) {
		return c.json(
			createApiError('BAD_REQUEST', 'Duplicate $id values in nodes', [
				{ field: 'nodes.$id', message: 'Each node must have a unique $id' },
			]),
			400,
		)
	}

	// Validate object types against enabled extensions
	const settings = workspace.settings as WorkspaceSettings
	const enabledModules = getEnabledModuleIds(settings as Record<string, unknown>)
	const validTypes = getAllValidTypes(enabledModules, settings)
	for (const node of body.nodes) {
		if (!validTypes.includes(node.type)) {
			return c.json(createInvalidTypeError(node.type, `nodes[${node.$id}].type`, validTypes), 400)
		}
	}

	// Validate statuses against workspace settings
	const statuses = settings?.statuses
	if (statuses) {
		for (const node of body.nodes) {
			const validStatuses = statuses[node.type]
			if (validStatuses && !validStatuses.includes(node.status)) {
				return c.json(
					createApiError(
						'BAD_REQUEST',
						`Invalid status '${node.status}' for type '${node.type}' on node '${node.$id}'`,
						[
							{
								field: `nodes[${node.$id}].status`,
								message: `'${node.status}' is not valid for type '${node.type}'`,
								expected: validStatuses.map((s) => `'${s}'`).join(' | '),
								received: `'${node.status}'`,
							},
						],
						`Valid statuses for '${node.type}': ${validStatuses.join(', ')}`,
					),
					400,
				)
			}
		}
	}

	// Validate edge references
	const nodeIds = new Set(ids)
	for (const edge of body.edges) {
		const sourceIsRef = nodeIds.has(edge.source)
		const sourceIsUuid = UUID_REGEX.test(edge.source)
		if (!sourceIsRef && !sourceIsUuid) {
			return c.json(
				createApiError('BAD_REQUEST', `Edge source '${edge.source}' is not a valid $id or UUID`, [
					{
						field: 'edges.source',
						message: 'Must reference a node $id or be a valid UUID',
						received: `'${edge.source}'`,
					},
				]),
				400,
			)
		}

		const targetIsRef = nodeIds.has(edge.target)
		const targetIsUuid = UUID_REGEX.test(edge.target)
		if (!targetIsRef && !targetIsUuid) {
			return c.json(
				createApiError('BAD_REQUEST', `Edge target '${edge.target}' is not a valid $id or UUID`, [
					{
						field: 'edges.target',
						message: 'Must reference a node $id or be a valid UUID',
						received: `'${edge.target}'`,
					},
				]),
				400,
			)
		}
	}

	// Execute everything in a transaction
	let result: {
		nodes: (typeof objects.$inferSelect & { $id: string })[]
		edges: (typeof relationships.$inferSelect)[]
	}
	try {
		result = await db.transaction(async (tx) => {
			// 1. Create all nodes
			const idMap = new Map<string, string>()
			const createdNodes: (typeof objects.$inferSelect & { $id: string })[] = []

			for (const node of body.nodes) {
				const [created] = await tx
					.insert(objects)
					.values({
						workspaceId,
						type: node.type,
						title: node.title,
						content: node.content,
						status: node.status,
						metadata: node.metadata,
						owner: node.owner,
						createdBy: actorId,
					})
					.returning()

				if (!created) {
					throw new Error(`Failed to create node '${node.$id}'`)
				}
				idMap.set(node.$id, created.id)
				createdNodes.push({ ...created, $id: node.$id })

				await tx.insert(events).values({
					workspaceId,
					actorId,
					action: 'created',
					entityType: node.type,
					entityId: created.id,
					data: created,
				})
			}

			// 2. Resolve edge references and create relationships
			const createdEdges: (typeof relationships.$inferSelect)[] = []

			for (const edge of body.edges) {
				const sourceId = idMap.get(edge.source) ?? edge.source
				const targetId = idMap.get(edge.target) ?? edge.target

				// Look up the type for each side
				const sourceNode = createdNodes.find((n) => n.id === sourceId)
				const targetNode = createdNodes.find((n) => n.id === targetId)

				const [created] = await tx
					.insert(relationships)
					.values({
						sourceType: sourceNode?.type ?? 'object',
						sourceId,
						targetType: targetNode?.type ?? 'object',
						targetId,
						type: edge.type,
						createdBy: actorId,
					})
					.returning()

				if (!created) {
					throw new Error(`Failed to create edge from '${edge.source}' to '${edge.target}'`)
				}
				createdEdges.push(created)

				await tx.insert(events).values({
					workspaceId,
					actorId,
					action: 'created',
					entityType: 'relationship',
					entityId: created.id,
					data: created,
				})
			}

			return { nodes: createdNodes, edges: createdEdges }
		})
	} catch (err) {
		logger.error('Graph transaction failed', { error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create graph'), 500)
	}

	// Auto-subscribe the creator to every node so they're notified about future
	// comments. Mirrors POST /api/objects; runs outside the transaction for the
	// same reason — a subscription failure must not roll back graph creation.
	for (const node of result.nodes) {
		await autoSubscribe(db, {
			workspaceId,
			actorId,
			entityType: 'object',
			entityId: node.id,
			source: 'author',
		})
	}

	// Build a title lookup for every object referenced by an edge. Newly created
	// nodes already have titles in-hand; for edges that point at pre-existing
	// objects, fetch their titles in a single batch so the response can include
	// sourceTitle/targetTitle on every edge.
	const titleById = new Map<string, string | null>()
	for (const node of result.nodes) {
		titleById.set(node.id, node.title ?? null)
	}
	const externalIds = new Set<string>()
	for (const edge of result.edges) {
		if (!titleById.has(edge.sourceId)) externalIds.add(edge.sourceId)
		if (!titleById.has(edge.targetId)) externalIds.add(edge.targetId)
	}
	if (externalIds.size > 0) {
		const externalRows = await db
			.select({ id: objects.id, title: objects.title })
			.from(objects)
			.where(inArray(objects.id, [...externalIds]))
		for (const row of externalRows) titleById.set(row.id, row.title ?? null)
	}

	const response = {
		nodes: result.nodes.map((n) => ({
			...serialize(n),
			$id: n.$id,
		})),
		edges: result.edges.map((e) => ({
			...serialize(e),
			sourceTitle: titleById.get(e.sourceId) ?? null,
			targetTitle: titleById.get(e.targetId) ?? null,
		})),
	}

	return c.json(response as z.infer<typeof graphResponseSchema>, 201)
})

export default app
