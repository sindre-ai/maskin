import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, integrationTools, toolGrants } from '@maskin/db'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { validationFailureHook } from '../lib/errors'
import { seedGrantsIfFirstAdoption } from '../lib/tool-grants/seed'

// ---------------------------------------------------------------------------
// Which integrations each agent may use.
//
// Workspace comes from `X-Workspace-Id`, so membership is already enforced by
// `authMiddleware` before any handler runs.
//
// A row with `actorId: null` is the workspace CEILING — it narrows what an agent
// may be given but never grants anything on its own. That asymmetry is the whole
// safety property: connecting an integration must not silently arm every agent.
// ---------------------------------------------------------------------------

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const grantSchema = z.object({
	id: z.string(),
	actorId: z.string().nullable(),
	integrationRef: z.string(),
	mode: z.enum(['all', 'read', 'custom']),
	tools: z.array(z.string()),
})

const toolSchema = z.object({
	name: z.string(),
	description: z.string().nullable(),
	/** NULL means the server did not say. Never counted as read-only. */
	readOnly: z.boolean().nullable(),
})

const listRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Tool Grants'],
	summary: 'Grants in this workspace, and the tools each integration exposes',
	request: {
		query: z.object({
			/** Limit grants to one agent. The workspace ceiling is always included. */
			actor_id: z.string().uuid().optional(),
		}),
	},
	responses: {
		200: {
			description: 'Grants and known tools',
			content: {
				'application/json': {
					schema: z.object({
						grants: z.array(grantSchema),
						tools: z.record(z.string(), z.array(toolSchema)),
					}),
				},
			},
		},
		400: { description: 'X-Workspace-Id is required' },
	},
})

app.openapi(listRoute, async (c) => {
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) return c.json({ error: { message: 'X-Workspace-Id is required' } }, 400)

	const { actor_id: actorId } = c.req.valid('query')
	const db = c.get('db')

	const rows = await db
		.select()
		.from(toolGrants)
		.where(eq(toolGrants.workspaceId, workspaceId))
		.orderBy(asc(toolGrants.integrationRef))

	// Filtering here rather than in SQL keeps the ceiling rows in the response
	// whichever agent is asked about — the UI needs them to show what an agent
	// may be given, not only what it has.
	const grants = actorId
		? rows.filter((row) => row.actorId === actorId || row.actorId === null)
		: rows

	const toolRows = await db
		.select()
		.from(integrationTools)
		.where(eq(integrationTools.workspaceId, workspaceId))
		.orderBy(asc(integrationTools.name))

	const tools: Record<string, Array<z.infer<typeof toolSchema>>> = {}
	for (const row of toolRows) {
		const list = tools[row.integrationRef] ?? []
		list.push({ name: row.name, description: row.description, readOnly: row.readOnly })
		tools[row.integrationRef] = list
	}

	return c.json(
		{
			grants: grants.map((row) => ({
				id: row.id,
				actorId: row.actorId,
				integrationRef: row.integrationRef,
				mode: row.mode as 'all' | 'read' | 'custom',
				tools: row.tools ?? [],
			})),
			tools,
		},
		200,
	)
})

const upsertRoute = createRoute({
	method: 'put',
	path: '/',
	tags: ['Tool Grants'],
	summary: 'Grant an integration to an agent, or set the workspace ceiling',
	request: {
		body: {
			content: {
				'application/json': {
					schema: z.object({
						/** Omit for the workspace-level ceiling. */
						actorId: z.string().uuid().nullish(),
						integrationRef: z.string().min(1).max(200),
						mode: z.enum(['all', 'read', 'custom']),
						/** Required and non-empty for `custom`; ignored otherwise. */
						tools: z.array(z.string().min(1)).optional(),
					}),
				},
			},
		},
	},
	responses: {
		200: { description: 'Granted', content: { 'application/json': { schema: grantSchema } } },
		400: { description: 'Invalid grant' },
	},
})

app.openapi(upsertRoute, async (c) => {
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) return c.json({ error: { message: 'X-Workspace-Id is required' } }, 400)

	const body = c.req.valid('json')
	const db = c.get('db')
	const actorId = body.actorId ?? null

	if (body.mode === 'custom' && !body.tools?.length) {
		// An empty custom list admits nothing, which would present as a granted
		// integration that fails on every call. Refuse rather than store it.
		return c.json(
			{ error: { message: 'Choose at least one tool, or grant the whole integration.' } },
			400,
		)
	}

	// Before the FIRST grant lands, give every other agent what it can already
	// reach. Enforcement switches on with that first row, so without this a single
	// grant would silently strip every other agent in the workspace.
	await seedGrantsIfFirstAdoption(db, workspaceId)

	const values = {
		workspaceId,
		actorId,
		integrationRef: body.integrationRef,
		mode: body.mode,
		tools: body.mode === 'custom' ? (body.tools ?? []) : [],
		updatedAt: new Date(),
	}

	// Two partial unique indexes, so the conflict target differs by row kind —
	// `onConflictDoUpdate` must name the one that actually applies or the upsert
	// silently inserts a duplicate.
	await db
		.insert(toolGrants)
		.values(values)
		.onConflictDoUpdate({
			target: actorId
				? [toolGrants.actorId, toolGrants.integrationRef]
				: [toolGrants.workspaceId, toolGrants.integrationRef],
			targetWhere: actorId ? undefined : isNull(toolGrants.actorId),
			set: { mode: values.mode, tools: values.tools, updatedAt: values.updatedAt },
		})

	const [row] = await db
		.select()
		.from(toolGrants)
		.where(
			and(
				eq(toolGrants.workspaceId, workspaceId),
				eq(toolGrants.integrationRef, body.integrationRef),
				actorId ? eq(toolGrants.actorId, actorId) : isNull(toolGrants.actorId),
			),
		)
		.limit(1)

	if (!row) return c.json({ error: { message: 'Could not store the grant' } }, 400)

	await db.insert(events).values({
		workspaceId,
		actorId: c.get('actorId'),
		action: 'updated',
		entityType: 'tool_grant',
		entityId: row.id,
		data: { integrationRef: row.integrationRef, mode: row.mode, grantedTo: actorId },
	})

	return c.json(
		{
			id: row.id,
			actorId: row.actorId,
			integrationRef: row.integrationRef,
			mode: row.mode as 'all' | 'read' | 'custom',
			tools: row.tools ?? [],
		},
		200,
	)
})

const revokeRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['Tool Grants'],
	summary: 'Revoke a grant',
	request: { params: z.object({ id: z.string().uuid() }) },
	responses: {
		200: { description: 'Revoked' },
		404: { description: 'No such grant in this workspace' },
	},
})

app.openapi(revokeRoute, async (c) => {
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) return c.json({ error: { message: 'X-Workspace-Id is required' } }, 400)

	const { id } = c.req.valid('param')
	const db = c.get('db')

	// Scoped to the workspace in the DELETE itself: the id alone would let a
	// member of one workspace revoke another's grant.
	const [deleted] = await db
		.delete(toolGrants)
		.where(and(eq(toolGrants.id, id), eq(toolGrants.workspaceId, workspaceId)))
		.returning()

	if (!deleted) return c.json({ error: { message: 'Grant not found' } }, 404)

	await db.insert(events).values({
		workspaceId,
		actorId: c.get('actorId'),
		action: 'deleted',
		entityType: 'tool_grant',
		entityId: deleted.id,
		data: { integrationRef: deleted.integrationRef, grantedTo: deleted.actorId },
	})

	return c.json({ revoked: true }, 200)
})

export default app
